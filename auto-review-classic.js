/**
 * auto-review-classic.js — Monthly landmark VK album review
 *
 * Works through a curated list of ~55 essential Visual Kei albums in order of
 * cultural significance. Each run picks the next unreviewed entry, fetches
 * Wikipedia context, and writes a 500–600-word historical review with Claude
 * Haiku.
 *
 * Cron (1st of each month at 11am):
 *   0 11 1 * * cd /Users/robertnelson/vknewsblog && /usr/local/bin/node auto-review-classic.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { publishToJekyll, pingSitemap } from './lib/jekyll.js';

const anthropic     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REVIEWED_FILE = './reviewed-albums.json';

// ─── Curated list of landmark VK albums ───────────────────────────────────────
// Ordered by cultural weight — earliest and most historically significant first.
// The script works through this list in order, one album per month.

const CLASSIC_ALBUMS = [
  // ── Founders of the form ──────────────────────────────────────────────────
  { artist: 'X Japan',        title: 'Blue Blood',                   year: 1989 },
  { artist: 'X Japan',        title: 'Jealousy',                     year: 1991 },
  { artist: 'BUCK-TICK',      title: 'Taboo',                        year: 1988 },
  { artist: 'BUCK-TICK',      title: 'Seventh Heaven',               year: 1990 },
  { artist: 'BUCK-TICK',      title: 'darker than darkness -style 93-', year: 1993 },
  { artist: "L'Arc~en~Ciel",  title: 'DUNE',                         year: 1993 },
  { artist: "L'Arc~en~Ciel",  title: 'Tierra',                       year: 1994 },
  { artist: "L'Arc~en~Ciel",  title: 'TRUE',                         year: 1996 },
  { artist: "L'Arc~en~Ciel",  title: 'ark',                          year: 1999 },
  { artist: 'LUNA SEA',       title: 'IMAGE',                        year: 1992 },
  { artist: 'LUNA SEA',       title: 'Eden',                         year: 1993 },
  { artist: 'LUNA SEA',       title: 'MOTHER',                       year: 1994 },
  { artist: 'LUNA SEA',       title: 'STYLE',                        year: 1996 },
  { artist: 'Malice Mizer',   title: 'Voyage sans retour',           year: 1996 },
  { artist: 'Malice Mizer',   title: 'merveilles',                   year: 1998 },
  // ── 90s cult essentials ───────────────────────────────────────────────────
  { artist: 'Shazna',         title: 'MELTY LOVE',                   year: 1996 },
  { artist: 'PENICILLIN',     title: 'VIBE',                         year: 1997 },
  { artist: "Fanatic◇Crisis", title: 'Grace',                  year: 2001 },
  { artist: 'Raphael',        title: 'Unmei no Hana',                year: 1999 },
  { artist: 'Laputa',         title: 'Maze',                         year: 2001 },
  { artist: 'Cali≠Gari', title: 'Oishii Niku',                  year: 2005 },
  // ── Kote-kei / Oshare-kei golden age ─────────────────────────────────────
  { artist: 'Schwarz Stein',  title: 'Artificial Hallucination',     year: 2002 },
  { artist: 'Moi dix Mois',   title: 'Dix infernal',                 year: 2003 },
  { artist: 'MIYAVI',         title: 'Galyuu',                       year: 2003 },
  { artist: 'An Cafe',        title: 'Nyappy in the World 2',        year: 2007 },
  // ── 2000s neo-VK heavyweights ─────────────────────────────────────────────
  { artist: 'Dir en grey',    title: 'Gauze',                        year: 1999 },
  { artist: 'Dir en grey',    title: 'Macabre',                      year: 2000 },
  { artist: 'Dir en grey',    title: 'Withering to Death.',          year: 2005 },
  { artist: 'Dir en grey',    title: 'UROBOROS',                     year: 2008 },
  { artist: 'MUCC',           title: 'Homura Uta',                   year: 2002 },
  { artist: 'MUCC',           title: 'Kuchiki no Tou',               year: 2004 },
  { artist: 'Pierrot',        title: 'Dictators Circus',             year: 2001 },
  { artist: 'Pierrot',        title: 'Finale',                       year: 2004 },
  { artist: "D'ESPAIRSRAY",   title: 'MONSTERS',                     year: 2004 },
  { artist: "D'ESPAIRSRAY",   title: 'BORN',                         year: 2007 },
  { artist: 'Kagrra,',        title: 'Shizuku',                      year: 2006 },
  { artist: 'Deadman',        title: 'a transient peace',            year: 2005 },
  { artist: 'MERRY',          title: 'Nihon-Chinbotsu',              year: 2004 },
  { artist: 'Janne Da Arc',   title: 'JOKER',                        year: 2005 },
  { artist: 'SID',            title: 'hikari',                       year: 2008 },
  // ── 2006-2012 international breakthrough era ──────────────────────────────
  { artist: 'the GazettE',    title: 'NIL',                          year: 2006 },
  { artist: 'the GazettE',    title: 'DIM',                          year: 2009 },
  { artist: 'the GazettE',    title: 'TOXIC',                        year: 2011 },
  { artist: 'alice nine.',    title: 'ZEAL',                         year: 2006 },
  { artist: 'alice nine.',    title: 'Vandalize',                    year: 2007 },
  { artist: 'Versailles',     title: 'Noble',                        year: 2008 },
  { artist: 'Versailles',     title: 'Holy Grail',                   year: 2010 },
  { artist: 'Rentrer en Soi', title: 'Rentrer en Soi',               year: 2007 },
  { artist: 'lynch.',         title: 'GALLOWS',                      year: 2010 },
  { artist: 'Plastic Tree',   title: 'Present',                      year: 2006 },
  { artist: '-OZ-',           title: 'HANA',                         year: 2009 },
  { artist: 'vistlip',        title: 'Revolver',                     year: 2010 },
  { artist: 'Sadie',          title: 'ROSE HEAD',                    year: 2011 },
  { artist: 'NIGHTMARE',      title: 'Libido',                       year: 2005 },
  { artist: 'Phantasmagoria', title: 'Requiem et Reminiscence II',   year: 2006 },
  { artist: 'exist†trace',    title: 'TWIN GATE',                    year: 2010 },
  { artist: 'ayabie',         title: 'Yuuyake to Kishi',             year: 2007 },
  { artist: 'DIAURA',         title: 'Eros',                         year: 2012 },
];

// ─── Wikipedia bio ────────────────────────────────────────────────────────────

async function fetchWikiBio(name) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      signal:  AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'VKChronicle/1.0 (vkchronicle.com)' },
    });
    if (!res.ok) return null;
    const d    = await res.json();
    const desc = (d.description || '').toLowerCase();
    const nonBand = ['city', 'village', 'river', 'painter', 'politician', 'film', 'plant', 'deity', 'goddess', 'antibiotic'];
    if (nonBand.some(b => desc.includes(b))) return null;
    return d.extract || null;
  } catch { return null; }
}

// ─── Album art (iTunes) ───────────────────────────────────────────────────────

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

function classicKey(album) {
  return `classic::${album.artist.toLowerCase()}|${album.title.toLowerCase()}`;
}

// ─── Claude review writer ─────────────────────────────────────────────────────

async function writeClassicReview({ artist, title, year, artistBio, albumBio }) {
  const bioSection = [
    artistBio ? `Artist context:\n${artistBio.slice(0, 900)}` : '',
    albumBio  ? `Album context:\n${albumBio.slice(0, 600)}`   : '',
  ].filter(Boolean).join('\n\n');

  const prompt = `You are a music critic writing for VK Chronicle (vkchronicle.com), an English-language Visual Kei blog for Western fans.

Write an in-depth classic album review for:
Artist: ${artist}
Album: ${title}
Year: ${year}
${bioSection ? `\n${bioSection}` : ''}

This is a featured "Classic Album" review — a deeper, more historical piece for a landmark release.

Guidelines:
- 500–600 words
- Open with the album's place in Visual Kei history and why it still matters
- Cover the sonic character: instrumentation, production style, vocal performance, atmosphere
- Name and discuss specific standout tracks
- Place it in context: the band's discography, the VK scene at that time, its lasting influence
- Close with why a new listener should hear this album and a definitive rating
- Tone: authoritative, fan-knowledgeable, passionate — this is a classic, write it like one
- Do NOT fabricate specific lyrics, chart positions, or sales figures you are not certain of

Write an SEO-optimised title:
- Format: "${artist} – ${title} (${year}): Classic Album Review"
- Max 70 characters

Respond in EXACTLY this format:
TITLE: [review headline]
RATING: [number 1-10, digits only]
LABELS: [comma-separated: Classic Albums, Album Review, ${artist}, and 2-3 genre/era labels]
CONTENT:
[review body as plain paragraphs — no HTML tags]`;

  const message = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1536,
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
    labels:  [...new Set(['Visual Kei', 'Reviews', 'Classic Albums',
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
  console.log('── auto-review-classic (monthly) ──');

  const reviewed     = loadReviewed();
  const reviewedKeys = new Set(reviewed.map(r => r.key));

  const pick = CLASSIC_ALBUMS.find(a => !reviewedKeys.has(classicKey(a)));
  if (!pick) {
    console.log('All classic albums reviewed — add more to the list.');
    return;
  }

  console.log(`Picked: ${pick.artist} – ${pick.title} (${pick.year})`);

  const [artistBio, albumBio] = await Promise.all([
    fetchWikiBio(pick.artist),
    fetchWikiBio(`${pick.title} ${pick.artist} album`),
  ]);
  if (artistBio) console.log(`  Artist bio: ${artistBio.length} chars`);
  if (albumBio)  console.log(`  Album bio: ${albumBio.length} chars`);

  let review;
  try { review = await writeClassicReview({ ...pick, artistBio, albumBio }); }
  catch (err) { console.error(`Claude error: ${err.message}`); return; }
  console.log(`  Title: "${review.title}"`);
  console.log(`  Rating: ${review.rating}/10`);

  const imageUrl = await fetchAlbumArt(pick.artist, pick.title);
  if (imageUrl) console.log('  Album art found');

  const content = review.content
    + (review.rating ? `\n\n**Rating: ${review.rating}/10**` : '');

  const postUrl = publishToJekyll(
    review.title,
    review.labels,
    content,
    { imageUrl },
  );

  const key = classicKey(pick);
  reviewed.push({
    key,
    artist:   pick.artist,
    title:    review.title,
    album:    pick.title,
    year:     pick.year,
    url:      postUrl,
    rating:   review.rating,
    type:     'classic',
    postedAt: new Date().toISOString(),
  });
  saveReviewed(reviewed);

  await pingSitemap();
  await sendTelegram(`🎸 <b>VK Chronicle classic album review:</b> ${review.title} (${review.rating}/10)`);
  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
