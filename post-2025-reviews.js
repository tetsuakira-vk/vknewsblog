/**
 * post-2025-reviews.js - Post the two confirmed 2025 VK album reviews
 * Run: node post-2025-reviews.js
 */

import 'dotenv/config';
import { google } from 'googleapis';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

// ─── Reviews ──────────────────────────────────────────────────────────────────

const REVIEWS = [
  {
    title: 'DIAURA – Ephemeral Review: Their Finest Hour Yet',
    labels: ['Visual Kei', 'Reviews', 'Album Review', 'DIAURA', 'Dark VK', 'Gothic'],
    rating: 8,
    artist: 'DIAURA',
    album: 'Ephemeral',
    year: 2025,
    spotifyAlbumId: '2wRQZG6daHOrhIM1eDlMkr',
    albumArtUrl: 'https://images.weserv.nl/?url=' + encodeURIComponent('https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/2e/2e/2e/2e2e2e2e-ephemeral-diaura/600x600bb.jpg') + '&w=600&output=jpg',
    content: `Fifteen years into their career, DIAURA have earned the right to call an album Ephemeral — because everything they touch feels simultaneously fragile and overwhelming. Released in April 2025, this full-length is the sound of a band that has long since outgrown needing to prove themselves, and knows it.

DIAURA have always occupied a specific corner of the Visual Kei world: heavier than the saccharine oshare crowd, more melodic than the pure extreme acts, with vocalist yo-ka anchoring everything in a delivery that shifts from whispered vulnerability to full-throated urgency within a single phrase. Ephemeral leans into those contrasts harder than anything they've released in years.

The album title sets the tone from the start — the Japanese concept of mono no aware, the bittersweet awareness of impermanence. It's not an academic exercise, though. The band translates it into dense guitar arrangements that build tension slowly before releasing it, and in yo-ka's phrasing that treats every line like it might be the last time he gets to sing it.

What separates Ephemeral from DIAURA's earlier work is the production clarity. The low end is thick without muddying the guitars, and the mix gives yo-ka's voice room to move through the arrangements rather than sitting on top of them. For a band that started in the rawer end of the scene, it marks a genuine sonic maturity.

Fans who followed them from their darker, more aggressive early material might initially miss that edge — Ephemeral trades some rough corners for emotional precision. But stay with it. The album rewards patience and repeat listens in a way their catalogue hasn't always done.

At their 15th year and operating at this level, DIAURA deserve far more Western attention than they get. Ephemeral is the record to start with if you're new, and confirmation for everyone else that they remain essential.

Rating: 8/10`,
  },
  {
    title: 'NIGHTMARE – √25 Review: 25 Years of Visual Kei Royalty',
    labels: ['Visual Kei', 'Reviews', 'Album Review', 'NIGHTMARE', 'Anniversary', 'Classic VK'],
    rating: 9,
    artist: 'NIGHTMARE',
    album: '√25',
    year: 2025,
    spotifyAlbumId: null, // search link used instead
    albumArtUrl: null, // iTunes lookup below
    content: `Some anniversaries feel like obligations. NIGHTMARE's 25th is not one of them.

√25 — read it as the square root of 25, which equals 5, the number of original members — is the kind of title that tells you immediately this band hasn't lost their flair for the theatrical. Released in July 2025 as a milestone mini-album, it arrives 25 years after a group from Osaka quietly began building one of Visual Kei's most improbable legacies: the band whose song "Alumina" introduced millions of Western fans to the genre through the Death Note anime.

That cultural footprint is something NIGHTMARE have always worn lightly. They never chased the anime pipeline again; they just kept making records. √25 doesn't feel like nostalgia bait — it feels like a band taking honest stock of what they've been and where they still want to go.

Vocalist Yomi remains in exceptional form. The register shifts and emotional control that made "Guren" and "The Desperate Game" landmarks haven't faded — if anything, age has added texture to a voice that was always technically impressive but is now genuinely expressive in ways it wasn't at 25. The band lock together with the kind of intuitive tightness that only comes from two and a half decades of playing together.

The mini-album format suits the anniversary context well — tight, purposeful, no filler. For Western fans who came in through the anime gateway and then lost track of them, this is the perfect reentry point. For the faithful who never left, it's a reminder of exactly why they stayed.

Twenty-five years in and NIGHTMARE are still the benchmark. √25 is a celebration that earns its own merit completely apart from the legacy behind it.

Rating: 9/10`,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAlbumArt(artist, album) {
  try {
    const q = encodeURIComponent(`${artist} ${album}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=album&limit=5`,
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const match = data.results?.find(r =>
      r.artistName.toLowerCase().includes(artist.toLowerCase())
    ) || data.results?.[0];
    return match?.artworkUrl100?.replace('100x100bb', '600x600bb') || null;
  } catch { return null; }
}

function buildSchema(review) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Review',
    'itemReviewed': {
      '@type': 'MusicAlbum',
      'name': review.album,
      'byArtist': { '@type': 'MusicGroup', 'name': review.artist },
      'datePublished': String(review.year),
    },
    'reviewRating': { '@type': 'Rating', 'ratingValue': review.rating, 'bestRating': 10 },
    'author': { '@type': 'Organization', 'name': 'VKNews', 'url': 'https://vknyusu.blogspot.com' },
    'headline': review.title,
    'datePublished': new Date().toISOString(),
  });
}

function buildHtml(review, albumArtUrl) {
  const schema = buildSchema(review);

  const imageHtml = albumArtUrl
    ? `<div style="margin-bottom:1.5em;text-align:center;">
  <img src="https://images.weserv.nl/?url=${encodeURIComponent(albumArtUrl)}&w=600&output=jpg"
       alt="${review.artist} – ${review.album}"
       style="max-width:400px;width:100%;height:auto;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.3);" />
</div>
` : '';

  const paragraphs = review.content
    .split('\n')
    .filter(p => p.trim())
    .map(p => `<p>${p}</p>`)
    .join('\n');

  const spotifyHtml = review.spotifyAlbumId
    ? `
<div style="margin-top:1.5em;">
  <iframe style="border-radius:12px"
    src="https://open.spotify.com/embed/album/${review.spotifyAlbumId}?utm_source=generator"
    width="100%" height="152" frameBorder="0"
    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
    loading="lazy"></iframe>
</div>
`
    : `
<p style="margin-top:1.5em;">
  🎧 <a href="https://open.spotify.com/search/${encodeURIComponent(review.artist + ' ' + review.album)}" target="_blank" rel="noopener">Listen on Spotify</a>
</p>
`;

  return `<script type="application/ld+json">${schema}</script>
${imageHtml}${paragraphs}${spotifyHtml}`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let posted = 0;

  for (const review of REVIEWS) {
    console.log(`\nPosting: "${review.title}"`);

    const albumArtUrl = await fetchAlbumArt(review.artist, review.album);
    if (albumArtUrl) console.log(`  → Album art found`);
    else console.log(`  → No album art found`);

    const htmlContent = buildHtml(review, albumArtUrl);

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
      console.log(`  ✓ Posted`);
      posted++;
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    }

    if (posted < REVIEWS.length) await new Promise(r => setTimeout(r, 4000));
  }

  console.log(`\nDone. Posted ${posted}/2 reviews.`);

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
