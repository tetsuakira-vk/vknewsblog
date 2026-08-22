/**
 * post-reviews.js - Mass post Visual Kei album reviews to Blogger
 *
 * Uses Claude Haiku to write each review, iTunes API for album art,
 * and optionally embeds a YouTube video per album.
 *
 * Usage:
 *   node post-reviews.js --list      Preview albums to be reviewed (no posting)
 *   node post-reviews.js --post      Write and publish all reviews
 *   node post-reviews.js --post --album "Withering to Death"   Post one specific album
 *
 * To add a YouTube video: fill in the youtubeId field for that album.
 * Find the ID in the YouTube URL: youtube.com/watch?v=XXXXXXXXXXX
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';

// ─── Album List ───────────────────────────────────────────────────────────────
// youtubeId: the part after ?v= in the YouTube URL, or null to skip embed

const ALBUMS = [
  // ── Classics ──
  { artist: 'Dir En Grey',   album: 'Withering to Death',  year: 2005, youtubeId: null },
  { artist: 'The GazettE',   album: 'DISORDER',             year: 2004, youtubeId: null },
  { artist: 'Malice Mizer',  album: 'Merveilles',           year: 1998, youtubeId: null },
  { artist: 'Buck-Tick',     album: 'Kurutta Taiyou',       year: 1991, youtubeId: null },
  { artist: 'Luna Sea',      album: 'Mother',               year: 1994, youtubeId: null },
  { artist: 'Versailles',    album: 'Jubilee',              year: 2010, youtubeId: null },
  { artist: 'An Cafe',       album: 'Lollipop Kingdom',     year: 2007, youtubeId: null },
  { artist: 'Alice Nine',    album: 'Vandalize',            year: 2007, youtubeId: null },
  { artist: 'Nightmare',     album: 'Majestical Parade',    year: 2006, youtubeId: null },
  { artist: 'Girugamesh',    album: 'girugamesh',           year: 2006, youtubeId: null },
  { artist: 'Kagrra,',       album: 'Shizuku',              year: 2007, youtubeId: null },
  { artist: 'MERRY',         album: 'Gokusai',              year: 2008, youtubeId: null },
  // ── Newer ──
  { artist: 'The GazettE',   album: 'NINTH',                year: 2018, youtubeId: null },
  { artist: 'Dir En Grey',   album: 'The Insulated World',  year: 2018, youtubeId: null },
  { artist: 'Kizu',          album: 'Akai Ito',             year: 2019, youtubeId: null },
  { artist: 'Deviloof',      album: 'Debauchery',           year: 2020, youtubeId: null },
  { artist: 'Jiluka',        album: ' Constellation',        year: 2021, youtubeId: null },
];

// ─── Setup ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = !args.includes('--post');
const albumFilter = (() => {
  const idx = args.indexOf('--album');
  return idx !== -1 ? args[idx + 1]?.toLowerCase() : null;
})();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

// ─── iTunes album art ─────────────────────────────────────────────────────────

async function fetchAlbumArt(artist, album) {
  try {
    const q = encodeURIComponent(`${artist} ${album}`);
    const res = await fetch(
      `https://itunes.apple.com/search?term=${q}&entity=album&limit=5`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results?.length) return null;

    // Pick the closest match
    const match = data.results.find(r =>
      r.artistName.toLowerCase().includes(artist.toLowerCase()) ||
      artist.toLowerCase().includes(r.artistName.toLowerCase())
    ) || data.results[0];

    // Upscale from 100px thumbnail to 600px
    return match.artworkUrl100?.replace('100x100bb', '600x600bb') || null;
  } catch {
    return null;
  }
}

// ─── Claude review ────────────────────────────────────────────────────────────

async function writeReview({ artist, album, year }) {
  const prompt = `You are a music critic writing for VKNews (vknyusu.blogspot.com), an English-language Visual Kei blog for Western fans.

Write a compelling album review for:
Artist: ${artist}
Album: ${album}
Year: ${year}

Guidelines:
- 350–450 words
- Open with a hook — the album's mood, legacy, or significance
- Cover the overall sound, standout tracks (name specific songs), production, and what makes it essential listening
- Add context: where the album fits in the band's discography and in VK history
- End with a recommendation and a rating out of 10
- Tone: enthusiastic but critical — like a knowledgeable fan, not a press release
- Do NOT fabricate specific lyrics, exact chart positions, or dates you are unsure of

Write an SEO-optimised title:
- Front-load the band name, e.g. "${artist} – ${album} Review: ..."
- Be specific and descriptive, max 65 characters

Respond in EXACTLY this format:
TITLE: [review headline]
RATING: [number 1-10, digits only]
LABELS: [comma-separated: Album Review, ${artist}, and 2-3 relevant genre/mood labels]
CONTENT:
[review body]`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const titleMatch = text.match(/^TITLE:\s*(.+)/m);
  const ratingMatch = text.match(/^RATING:\s*(\d+)/m);
  const labelsMatch = text.match(/^LABELS:\s*(.+)/m);
  const contentMatch = text.match(/^CONTENT:\n([\s\S]+)/m);

  if (!titleMatch || !contentMatch) throw new Error('Unexpected Claude response format');

  return {
    title: titleMatch[1].trim(),
    rating: ratingMatch ? parseInt(ratingMatch[1], 10) : null,
    labels: [...new Set(['Visual Kei', 'Reviews', 'Album Review', ...(labelsMatch ? labelsMatch[1].split(',').map(l => l.trim()) : [])])],
    content: contentMatch[1].trim(),
  };
}

// ─── HTML formatting ──────────────────────────────────────────────────────────

function formatReviewHtml({ title, content, rating }, albumArtUrl, albumEntry, youtubeId) {
  const { artist, album, year } = albumEntry;
  const albumTitle = `${artist} – ${album}`;

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Review',
    'itemReviewed': {
      '@type': 'MusicAlbum',
      'name': album,
      'byArtist': { '@type': 'MusicGroup', 'name': artist },
      'datePublished': String(year),
    },
    ...(rating ? { 'reviewRating': { '@type': 'Rating', 'ratingValue': rating, 'bestRating': 10 } } : {}),
    'author': { '@type': 'Organization', 'name': 'VKNews', 'url': 'https://vknyusu.blogspot.com' },
    'headline': title,
    'datePublished': new Date().toISOString(),
  });

  const imageHtml = albumArtUrl
    ? `<div style="margin-bottom:1.5em;text-align:center;">
  <img src="https://images.weserv.nl/?url=${encodeURIComponent(albumArtUrl)}&w=600&output=jpg"
       alt="${albumTitle}" style="max-width:400px;width:100%;height:auto;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.3);" />
</div>\n`
    : '';

  const paragraphs = content
    .split('\n')
    .filter(p => p.trim())
    .map(p => `<p>${p}</p>`)
    .join('\n');

  const videoHtml = youtubeId
    ? `\n<div style="margin-top:1.5em;text-align:center;">
  <iframe width="560" height="315"
    src="https://www.youtube.com/embed/${youtubeId}"
    frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowfullscreen style="max-width:100%;"></iframe>
</div>\n`
    : '';

  return `<script type="application/ld+json">${schema}</script>
${imageHtml}${paragraphs}${videoHtml}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const toProcess = albumFilter
    ? ALBUMS.filter(a => a.album.toLowerCase().includes(albumFilter) || a.artist.toLowerCase().includes(albumFilter))
    : ALBUMS;

  if (toProcess.length === 0) {
    console.log('No albums matched that filter.');
    return;
  }

  if (dryRun) {
    console.log('Albums to be reviewed (use --post to publish):\n');
    toProcess.forEach(({ artist, album, year, youtubeId }) => {
      const yt = youtubeId ? `YouTube: ${youtubeId}` : 'No YouTube video';
      console.log(`  • ${artist} – ${album} (${year})  [${yt}]`);
    });
    console.log(`\nTotal: ${toProcess.length} reviews`);
    console.log('\nTip: Add YouTube video IDs to the ALBUMS list in post-reviews.js before posting.');
    return;
  }

  console.log(`Posting ${toProcess.length} album review(s)...\n`);
  let posted = 0;

  for (const albumEntry of toProcess) {
    const { artist, album, year, youtubeId } = albumEntry;
    console.log(`Writing review: ${artist} – ${album} (${year})`);

    let review;
    try {
      review = await writeReview(albumEntry);
    } catch (err) {
      console.error(`  ✗ Claude error: ${err.message}`);
      continue;
    }

    const albumArt = await fetchAlbumArt(artist, album);
    if (albumArt) console.log(`  → Album art found`);
    else console.log(`  → No album art found on iTunes`);

    const htmlContent = formatReviewHtml(review, albumArt, albumEntry, youtubeId);

    try {
      await blogger.posts.insert({
        blogId,
        isDraft: false,
        requestBody: {
          title: review.title,
          content: htmlContent,
          labels: review.labels,
        },
      });
      console.log(`  ✓ Posted: "${review.title}"`);
      posted++;
    } catch (err) {
      console.error(`  ✗ Blogger error: ${err.message}`);
    }

    // Polite delay
    if (posted < toProcess.length) await new Promise(r => setTimeout(r, 4000));
  }

  console.log(`\nDone. Posted ${posted}/${toProcess.length} reviews.`);

  if (posted > 0) {
    try {
      await fetch('https://www.google.com/ping?sitemap=https://vknyusu.blogspot.com/sitemap.xml',
        { signal: AbortSignal.timeout(8000) });
      console.log('Google sitemap pinged.');
    } catch { /* non-fatal */ }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
