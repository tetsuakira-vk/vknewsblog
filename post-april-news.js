/**
 * post-april-news.js - Post April 2026 upcoming VK release news
 * Run: node post-april-news.js
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

// ─── Upcoming Releases ────────────────────────────────────────────────────────

const RELEASES = [
  {
    artist: 'DIAURA',
    title: 'INCOMPLETE III',
    releaseDate: 'April 1, 2026',
    type: 'compilation',
    editions: ['Standard edition'],
    notes: '15th anniversary collection',
    sourceUrl: 'https://vk.gy',
    sourceTitle: 'vk.gy',
    labels: ['News', 'Album Release', 'DIAURA', 'Dark VK', 'Visual Kei'],
  },
  {
    artist: 'DIR EN GREY',
    title: 'MORTAL DOWNER',
    releaseDate: 'April 8, 2026',
    type: 'album',
    editions: ['Standard', 'Limited DVD', 'Limited Blu-ray', 'Shokai Limited'],
    notes: null,
    sourceUrl: 'https://vk.gy',
    sourceTitle: 'vk.gy',
    labels: ['News', 'Album Release', 'Dir En Grey', 'Visual Kei'],
  },
  {
    artist: 'KIZU',
    title: 'Gokuraku yori Gokujou no Ame',
    releaseDate: 'April 8, 2026',
    type: 'album',
    editions: ['Type A', 'Type B', 'Standard'],
    notes: null,
    sourceUrl: 'https://vk.gy',
    sourceTitle: 'vk.gy',
    labels: ['News', 'Album Release', 'KIZU', 'Visual Kei'],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAlbumArt(artist, album) {
  try {
    const q = encodeURIComponent(`${artist} ${album}`);
    const res = await fetch(
      `https://itunes.apple.com/search?term=${q}&entity=album&limit=5`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const match = data.results?.find(r =>
      r.artistName.toLowerCase().includes(artist.toLowerCase())
    ) || data.results?.[0];
    return match?.artworkUrl100?.replace('100x100bb', '600x600bb') || null;
  } catch {
    return null;
  }
}

async function writeNewsPost(release) {
  const editionList = release.editions.map(e => `• ${e}`).join('\n');
  const notesLine = release.notes ? `Additional context: ${release.notes}` : '';

  const prompt = `You are the editor of VKNews (vknyusu.blogspot.com), an English-language Visual Kei music news blog for Western fans.

Write a news post announcing an upcoming Visual Kei release:

Artist: ${release.artist}
Release title: ${release.title}
Release date: ${release.releaseDate}
Type: ${release.type}
Editions:
${editionList}
${notesLine}

Guidelines:
- 200–300 words
- Open with a hook about the release and its significance
- Give brief context about the band for new readers
- List the available editions clearly
- End with a call to action (pre-order, mark the date, etc.)
- Tone: enthusiastic but editorial
- Do NOT fabricate specific track listings, prices, or links you don't know

Write an SEO-optimised post title:
- Front-load the band name and key news hook
- Be specific (e.g. "${release.artist} Announce ${release.title} for ${release.releaseDate}")
- 65 characters max

Respond in EXACTLY this format:
TITLE: [post headline]
CONTENT:
[post body]`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const titleMatch = text.match(/^TITLE:\s*(.+)/m);
  const contentMatch = text.match(/^CONTENT:\n([\s\S]+)/m);

  if (!titleMatch || !contentMatch) throw new Error('Unexpected Claude response format');

  return {
    title: titleMatch[1].trim(),
    content: contentMatch[1].trim(),
  };
}

function buildHtml(postTitle, content, albumArtUrl, release) {
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    'headline': postTitle,
    'datePublished': new Date().toISOString(),
    'author': { '@type': 'Organization', 'name': 'VKNews', 'url': 'https://vknyusu.blogspot.com' },
    'publisher': { '@type': 'Organization', 'name': 'VKNews', 'url': 'https://vknyusu.blogspot.com' },
  });

  const imageHtml = albumArtUrl
    ? `<div style="margin-bottom:1.5em;text-align:center;">
  <img src="https://images.weserv.nl/?url=${encodeURIComponent(albumArtUrl)}&w=600&output=jpg"
       alt="${release.artist} – ${release.title}"
       style="max-width:400px;width:100%;height:auto;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.3);" />
</div>
`
    : '';

  const paragraphs = content
    .split('\n')
    .filter(p => p.trim())
    .map(p => `<p>${p}</p>`)
    .join('\n');

  return `<script type="application/ld+json">${schema}</script>
${imageHtml}${paragraphs}
<p style="margin-top:1.5em;font-size:0.85em;color:#999;">
  Source: <a href="${release.sourceUrl}" target="_blank" rel="noopener">${release.sourceTitle}</a>
</p>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let posted = 0;

  for (const release of RELEASES) {
    console.log(`\nProcessing: ${release.artist} – ${release.title}`);

    let post;
    try {
      post = await writeNewsPost(release);
    } catch (err) {
      console.error(`  ✗ Claude error: ${err.message}`);
      continue;
    }

    console.log(`  Title: "${post.title}"`);

    const albumArtUrl = await fetchAlbumArt(release.artist, release.title);
    if (albumArtUrl) console.log(`  → Album art found`);
    else console.log(`  → No album art found`);

    const htmlContent = buildHtml(post.title, post.content, albumArtUrl, release);

    try {
      await blogger.posts.insert({
        blogId,
        isDraft: false,
        requestBody: {
          title: post.title,
          content: htmlContent,
          labels: release.labels,
        },
      });
      console.log(`  ✓ Posted`);
      posted++;
    } catch (err) {
      console.error(`  ✗ Blogger error: ${err.message}`);
    }

    if (posted < RELEASES.length) await new Promise(r => setTimeout(r, 4000));
  }

  console.log(`\nDone. Posted ${posted}/${RELEASES.length} news posts.`);

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
