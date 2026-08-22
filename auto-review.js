/**
 * auto-review.js — Weekly new-release review
 *
 * Reads _data/this_week.json (written by fetch-weekly-embeds.js), picks the
 * most prominent artist by VK scene standing, writes a 350–450-word review
 * with Claude Haiku, publishes as a Jekyll post.
 *
 * Cron (Sundays 11am, after fetch-weekly-embeds at 9am + update-releases at 9:30am):
 *   0 11 * * 0 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node auto-review.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { publishToJekyll, SITE_REPO_PATH, pingSitemap } from './lib/jekyll.js';

const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REVIEWED_FILE = './reviewed-albums.json';

// ─── Artist prominence (VK scene standing) ────────────────────────────────────
// Normalised as all-lowercase alphanum only for matching.
// Higher score = prioritised for review when they release this week.
// D'ESPAIRSRAY > HYDE solo: full-band comeback > solo single in VK context.

const PROMINENCE = {
  direngrey:         100,
  xjapan:             99,
  larcenciel:         98,
  bucktick:           97,
  lunasea:            96,
  malicemizer:        95,
  thegazette:         94,
  gazette:            94,
  mucc:               93,
  despairsray:        92,
  versailles:         90,
  miyavi:             89,
  nightmare:          88,
  alicenine:          87,
  jannedarc:          86,
  pierrot:            85,
  lynch:              84,
  kagrra:             83,
  plastictree:        82,
  hyde:               82,
  merry:              81,
  sid:                80,
  nocturnalbloodlust: 77,
  ancafe:             76,
  vistlip:            73,
  sadie:              72,
  royz:               71,
  arlequin:           70,
  goldenbomber:       68,
  acme:               65,
  jiluka:             63,
  dimlim:             60,
  born:               57,
  diaura:             55,
  deathgaze:          53,
  xaaxaa:             50,
  asagi:              48,
};

function normArtist(s) {
  return s.toLowerCase().replace(/[^\w]/g, '');
}

function getProminence(artist) {
  const n = normArtist(artist);
  if (PROMINENCE[n] !== undefined) return PROMINENCE[n];
  for (const [key, score] of Object.entries(PROMINENCE)) {
    if (n.includes(key) || key.includes(n)) return score;
  }
  return 0;
}

// ─── Wikipedia bio ────────────────────────────────────────────────────────────

async function fetchWikiBio(name) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'VKChronicle/1.0 (vkchronicle.com)' },
    });
    if (!res.ok) return null;
    const d = await res.json();
    const desc = (d.description || '').toLowerCase();
    const nonBand = ['city', 'village', 'river', 'painter', 'politician', 'film', 'plant', 'deity', 'goddess'];
    if (nonBand.some(b => desc.includes(b))) return null;
    return d.extract || null;
  } catch { return null; }
}

// ─── vk.gy release format ─────────────────────────────────────────────────────
// Returns e.g. "single", "mini-album", "album", "ep" or null.
// vk.gy uses <a href="/search/releases/?format=XXXX"> inside .data__item blocks.

async function fetchReleaseFormat(vkgyUrl) {
  if (!vkgyUrl) return null;
  try {
    const res = await fetch(vkgyUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const link = $('a[href*="?format="]').first();
    const fmt = link.find('.any--en').first().text().trim() || link.text().trim();
    return fmt.toLowerCase() || null;
  } catch { return null; }
}

// Human-readable label for a format string
function formatLabel(fmt) {
  if (!fmt) return 'Album Review';
  if (fmt.includes('single'))     return 'Single Review';
  if (fmt.includes('mini'))       return 'Mini-Album Review';
  if (fmt === 'ep')               return 'EP Review';
  if (fmt.includes('album'))      return 'Album Review';
  return 'Review';
}

// ─── Album art (iTunes fallback) ──────────────────────────────────────────────

async function fetchAlbumArt(artist, title) {
  try {
    const q   = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=album&limit=5`,
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data  = await res.json();
    const match = data.results?.find(r => r.artistName.toLowerCase().includes(artist.toLowerCase()))
      || data.results?.[0];
    return match?.artworkUrl100?.replace('100x100bb', '600x600bb') || null;
  } catch { return null; }
}

// ─── Reviewed tracking ────────────────────────────────────────────────────────

function loadReviewed() {
  if (!existsSync(REVIEWED_FILE)) return [];
  try { return JSON.parse(readFileSync(REVIEWED_FILE, 'utf8')); } catch { return []; }
}

function saveReviewed(list) {
  writeFileSync(REVIEWED_FILE, JSON.stringify(list, null, 2));
}

// ─── Claude review writer ─────────────────────────────────────────────────────

async function writeReview({ artist, title, date, wikiBio, format }) {
  const year      = date ? date.slice(0, 4) : new Date().getFullYear();
  const fmtLabel  = formatLabel(format);
  const fmtWord   = format || 'release';
  const bioCtx    = wikiBio ? `\n\nBand context from Wikipedia:\n${wikiBio.slice(0, 800)}` : '';

  // Tailor word count and guidance to release type
  const isSingle  = fmtWord.includes('single');
  const wordCount = isSingle ? '250–350' : '350–450';
  const fmtGuide  = isSingle
    ? '- This is a SINGLE (1–3 tracks). Do NOT call it an album. Focus on the track(s), the sonic direction, and what the single signals for the band\'s current chapter.'
    : `- This is a ${fmtWord}. Discuss the overall sound, any standout tracks, production, and what it means in the VK landscape.`;

  const prompt = `You are a music critic writing for VK Chronicle (vkchronicle.com), an English-language Visual Kei blog for Western fans.

Write a compelling review for this week's featured release:
Artist: ${artist}
Title: ${title}
Format: ${fmtWord}
Release year: ${year}
${bioCtx}

Guidelines:
- ${wordCount} words
- Open with a hook — the band's legacy, significance, or what makes this release an event
${fmtGuide}
- If specific track details are not known, focus on the artist's established direction and the cultural weight of the release
- End with a recommendation and a rating out of 10
- Tone: enthusiastic but critical — knowledgeable fan, not a press release
- Do NOT fabricate specific lyrics, exact chart positions, or track listing details you are not certain of

Write an SEO-optimised title:
- Front-load the band name: "${artist} – ${title} Review: ..."
- Be specific and descriptive, max 65 characters

Respond in EXACTLY this format:
TITLE: [review headline]
RATING: [number 1-10, digits only]
LABELS: [comma-separated: ${fmtLabel}, ${artist}, and 2-3 relevant genre/mood labels]
CONTENT:
[review body as plain paragraphs — no HTML tags]`;

  const message = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text         = message.content[0].text.trim();
  const titleMatch   = text.match(/^TITLE:\s*(.+)/m);
  const ratingMatch  = text.match(/^RATING:\s*(\d+)/m);
  const labelsMatch  = text.match(/^LABELS:\s*(.+)/m);
  const contentMatch = text.match(/^CONTENT:\n([\s\S]+)/m);

  if (!titleMatch || !contentMatch) throw new Error('Unexpected Claude response format');

  return {
    title:   titleMatch[1].trim(),
    rating:  ratingMatch ? parseInt(ratingMatch[1], 10) : null,
    labels:  [...new Set(['Visual Kei', 'Reviews', 'New Releases', fmtLabel,
      ...(labelsMatch ? labelsMatch[1].split(',').map(l => l.trim()) : [])])],
    content: contentMatch[1].trim(),
  };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      signal:  AbortSignal.timeout(8000),
    });
  } catch { /* non-fatal */ }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('── auto-review (weekly) ──');

  const weekFile = path.join(SITE_REPO_PATH, '_data', 'this_week.json');
  if (!existsSync(weekFile)) {
    console.log('this_week.json not found — run fetch-weekly-embeds.js first.');
    return;
  }

  let releases;
  try { releases = JSON.parse(readFileSync(weekFile, 'utf8')); }
  catch { console.error('Could not parse this_week.json'); return; }

  if (!releases.length) { console.log('No releases this week.'); return; }

  const reviewed     = loadReviewed();
  const reviewedKeys = new Set(reviewed.map(r => r.key));

  // Score by prominence; break ties by whether a YouTube embed was found
  const scored = releases
    .map(r => ({
      ...r,
      prominence: getProminence(r.artist),
      ytBonus:    r.youtube_id ? 1 : 0,
    }))
    .sort((a, b) =>
      (b.prominence + b.ytBonus) - (a.prominence + a.ytBonus)
    );

  // Find first candidate not already reviewed
  let pick = null;
  for (const r of scored) {
    const key = `${r.artist.toLowerCase()}|${r.title.toLowerCase()}`;
    if (!reviewedKeys.has(key)) { pick = { ...r, key }; break; }
  }

  if (!pick) {
    console.log('All this week\'s releases already reviewed. Nothing to do.');
    return;
  }

  console.log(`Picked: ${pick.artist} – ${pick.title} (prominence ${pick.prominence})`);

  const [wikiBio, format] = await Promise.all([
    fetchWikiBio(pick.artist),
    fetchReleaseFormat(pick.vkgy_url),
  ]);
  if (wikiBio) console.log(`  Wikipedia bio: ${wikiBio.length} chars`);
  console.log(`  Format: ${format || '(unknown — defaulting to album)'}`);

  let review;
  try { review = await writeReview({ ...pick, wikiBio, format }); }
  catch (err) { console.error(`Claude error: ${err.message}`); return; }
  console.log(`  Title: "${review.title}"`);
  console.log(`  Rating: ${review.rating}/10`);

  // Prefer vk.gy cover → iTunes fallback
  let imageUrl = pick.image || await fetchAlbumArt(pick.artist, pick.title);
  if (imageUrl) console.log('  Cover image found');

  const content = review.content
    + (review.rating ? `\n\n**Rating: ${review.rating}/10**` : '')
    + (pick.vkgy_url ? `\n\n[View on vk.gy](${pick.vkgy_url})` : '');

  const postUrl = publishToJekyll(
    review.title,
    review.labels,
    content,
    { imageUrl, sourceUrl: pick.vkgy_url },
  );

  reviewed.push({
    key:      pick.key,
    artist:   pick.artist,
    title:    review.title,
    url:      postUrl,
    rating:   review.rating,
    type:     'weekly',
    postedAt: new Date().toISOString(),
  });
  saveReviewed(reviewed);

  await pingSitemap();
  await sendTelegram(`⭐ <b>VK Chronicle weekly review:</b> ${review.title} (${review.rating}/10)`);
  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
