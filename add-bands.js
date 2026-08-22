/**
 * add-bands.js
 * Adds new band profiles to the _bands/ collection.
 *
 * Sources:
 *   --source vkdb    (default) vkdb.jp popularity-ordered list
 *   --source lastfm  Last.fm top visual-kei tag artists (English-named, has photo)
 *
 * Usage:
 *   node add-bands.js                       # vkdb, up to 100
 *   node add-bands.js --limit 10            # vkdb, 10 bands
 *   node add-bands.js --source lastfm --limit 10
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';
import { pushWithRebase } from './lib/jekyll.js';

const SITE_REPO_PATH = '/Users/robertnelson/vkchronicle';
const BANDS_DIR = `${SITE_REPO_PATH}/_bands`;
const COMMIT_EVERY = 10;

const limitArg = process.argv.indexOf('--limit');
const MAX_NEW = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : 100;
const sourceArg = process.argv.indexOf('--source');
const SOURCE = sourceArg !== -1 ? process.argv[sourceArg + 1] : 'vkdb';

// Non-VK acts that appear in Last.fm's visual-kei tag but shouldn't be included
const LASTFM_SKIP = new Set([
  'scrobble from spotify?', 'yohio', 'nano', 'gackt', 'yoshiki',
  'golden bomber', 'ゴールデンボンバー', 'maverick', 'hero', 'kurt', 'beau', 'sai',
  'sito magus', 'r指定', 'ove', 'mask', 'cameo', 'mannequin',
]);

// ─── Scrape vkdb.jp popularity-ordered band list ─────────────────────────────

async function fetchVkdbBandNames() {
  // The access count page lists bands ordered by how often their pages are visited
  const res = await fetch('http://www.vkdb.jp/%A5%A2%A5%AF%A5%BB%A5%B9%BF%F4.html', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`vkdb.jp access count page returned ${res.status}`);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('euc-jp').decode(buf);
  const $ = cheerio.load(html);

  const seen = new Set();
  const names = [];

  $('a[href$=".html"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    // Skip nav/system pages — they contain %, /, or known keywords
    if (href.includes('%') || href.includes('/') || href.includes('wiki') ||
        href.includes('Contents') || href.includes('NEWS') || href.includes('Menu') ||
        href.includes('VkDb') || href.includes('release') || href.includes('events') ||
        href.includes('FrontPage') || href.includes('index')) return;
    const name = decodeURIComponent(href.replace('.html', '').replace(/\+/g, ' ')).trim();
    // Only keep ASCII-readable names and deduplicate (page lists same names multiple times)
    if (name && /^[\x20-\x7E]+$/.test(name) && name.length > 1 && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  });

  return names; // already in popularity order
}

// ─── Scrape Last.fm top visual-kei artists ────────────────────────────────────

async function fetchLastFmTopVKArtists(pages = 5) {
  const names = [];
  const seen = new Set();

  for (let page = 1; page <= pages; page++) {
    const url = `https://www.last.fm/tag/visual+kei/artists${page > 1 ? '?page=' + page : ''}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) break;
      const html = await res.text();
      const $ = cheerio.load(html);
      $('h3').each((_, el) => {
        const name = $(el).text().trim();
        if (!name) return;
        if (LASTFM_SKIP.has(name.toLowerCase())) return;
        // Skip Japanese-only names (no ASCII letters)
        if (!/[a-zA-Z]/.test(name)) return;
        if (seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        names.push(name);
      });
    } catch { break; }
    await sleep(500);
  }

  console.log(`  → ${names.length} candidates from Last.fm top visual-kei tag`);
  return names;
}

// ─── Existing band deduplication ─────────────────────────────────────────────

function normaliseName(n) {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getExistingBandNames() {
  return new Set(
    readdirSync(BANDS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const raw = readFileSync(`${BANDS_DIR}/${f}`, 'utf8');
        const m = raw.match(/^name:\s+"([^"]+)"/m) || raw.match(/^name:\s+'([^']+)'/m);
        return m ? normaliseName(m[1]) : normaliseName(f.replace('.md', '').replace(/-/g, ' '));
      })
  );
}

function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Photo lookup ─────────────────────────────────────────────────────────────

async function fetchLastFmPhoto(name) {
  try {
    const res = await fetch(`https://www.last.fm/music/${encodeURIComponent(name)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const img = $('meta[property="og:image"]').attr('content');
    if (img && img.startsWith('http') && !img.includes('placeholder') && !img.includes('/meta/') && !img.includes('/avatar')) return img;
    return null;
  } catch { return null; }
}

async function fetchItunesPhoto(name) {
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&country=jp&entity=musicArtist&limit=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const url = data.results?.[0]?.artworkUrl100;
    return url ? url.replace('100x100bb', '600x600bb') : null;
  } catch { return null; }
}

// ─── Claude profile generation ────────────────────────────────────────────────

const REFUSAL_PATTERNS = [
  "don't have reliable", "don't have specific", "cannot confidently",
  "cannot fulfill", "apologize", "training data", "i cannot provide",
  "i'm unable", "i am unable", "not able to", "recommend checking",
  "consult", "fan communities", "no information",
];

function isRefusal(text) {
  const lower = text.toLowerCase();
  return REFUSAL_PATTERNS.some(p => lower.includes(p));
}

async function generateProfile(anthropic, bandName) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Write a 3-sentence biography of the Visual Kei band "${bandName}" for a fan directory. This is a confirmed Visual Kei act from vkdb.jp, the definitive Japanese VK database — do not question whether they are VK. Use any specific knowledge you have about them. If your knowledge is limited, write 3 confident sentences about a Japanese VK act of that name covering their theatrical visual style, dark or dramatic sound, and their place in the indie or major VK scene. Reply with only the 3 sentences — no caveats, no apologies, no headings, no recommendations to check other sources.`,
    }],
  });
  const text = msg.content[0]?.text?.trim() || null;
  if (!text || isRefusal(text)) return null;
  return text;
}

async function generateTopTracks(anthropic, bandName) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `List 3 well-known song titles by the Visual Kei band "${bandName}". Reply with just the 3 titles, one per line, no numbering, no explanation. If you don't know any songs, reply: UNKNOWN`,
    }],
  });
  const text = msg.content[0]?.text?.trim() || '';
  if (text === 'UNKNOWN' || !text) return [];
  return text.split('\n').map(t => t.trim()).filter(Boolean).slice(0, 3);
}

// ─── File writing ─────────────────────────────────────────────────────────────

function writeBandFile(slug, name, photo, description, topTracks) {
  const escaped = name.replace(/"/g, '\\"');
  const photoLine = photo ? `photo: "${photo}"\n` : '';
  const tracksYaml = topTracks.length
    ? `top_tracks:\n${topTracks.map(t => `  - "${t.replace(/"/g, '\\"')}"`).join('\n')}\n`
    : '';
  const cdJapanUrl = `https://www.cdjapan.co.jp/searches?term.artist_name_search=${encodeURIComponent(name)}&genre=JPOP&subgenre_id=VK`;
  const lastfmSlug = name.replace(/\s+/g, '+');
  const added = new Date().toISOString().slice(0, 10);

  const content = `---
layout: band
name: "${escaped}"
title: "${escaped}"
${photoLine}tags: ["visual kei"]
lastfm_slug: "${lastfmSlug}"
cdjapan_url: "${cdJapanUrl}"
added: "${added}"
${tracksYaml}---

${description}
`;
  writeFileSync(`${BANDS_DIR}/${slug}.md`, content, 'utf8');
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function commitBatch(slugs) {
  try {
    const files = slugs.map(s => `"_bands/${s}.md"`).join(' ');
    execSync(
      `git -C "${SITE_REPO_PATH}" add ${files} && git -C "${SITE_REPO_PATH}" commit -m "Add ${slugs.length} bands from vkdb.jp"`,
      { stdio: 'pipe' }
    );
    console.log(`  ✓ Committed ${slugs.length} bands (push at end)`);
  } catch (err) {
    console.warn(`  Git error: ${err.stderr?.toString().slice(0, 100)}`);
  }
}

function pushOnce() {
  try {
    pushWithRebase();
    console.log('  ✓ Pushed to GitHub');
  } catch (err) {
    console.warn(`  Push error: ${err.stderr?.toString().slice(0, 100)}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let sourceNames;
  if (SOURCE === 'lastfm') {
    console.log('Fetching band list from Last.fm top visual-kei artists...');
    sourceNames = await fetchLastFmTopVKArtists(5);
  } else {
    console.log('Fetching band list from vkdb.jp...');
    sourceNames = await fetchVkdbBandNames();
    console.log(`  → ${sourceNames.length} English-named bands found on vkdb.jp`);
  }

  const existing = getExistingBandNames();
  console.log(`  → ${existing.size} bands already in collection`);

  const newBands = sourceNames.filter(n => !existing.has(normaliseName(n)));
  console.log(`  → ${newBands.length} new bands to process (capped at ${MAX_NEW})\n`);

  let added = 0;
  let batch = [];

  for (const name of newBands) {
    if (added >= MAX_NEW) break;

    const slug = toSlug(name);

    // Skip if file somehow already exists
    if (existsSync(`${BANDS_DIR}/${slug}.md`)) continue;

    console.log(`[${added + 1}/${MAX_NEW}] ${name}`);

    // Photo — for lastfm source, require a photo (it's our popularity gate)
    let photo = await fetchLastFmPhoto(name);
    if (photo) {
      console.log(`  → Last.fm photo`);
    } else {
      photo = await fetchItunesPhoto(name);
      if (photo) {
        console.log(`  → iTunes photo`);
      } else if (SOURCE === 'lastfm') {
        console.log(`  → No photo found — skipping (not notable enough)`);
        await sleep(300);
        continue;
      } else {
        console.log(`  → No photo (will use placeholder)`);
      }
    }

    const description = await generateProfile(anthropic, name);
    if (!description) {
      console.log(`  → No description generated, skipping`);
      await sleep(300);
      continue;
    }

    // Top tracks
    const topTracks = await generateTopTracks(anthropic, name);

    writeBandFile(slug, name, photo, description, topTracks);
    console.log(`  ✓ Created _bands/${slug}.md`);

    batch.push(slug);
    added++;

    // Commit every COMMIT_EVERY bands
    if (batch.length >= COMMIT_EVERY) {
      commitBatch(batch);
      batch = [];
    }

    await sleep(800); // avoid hammering APIs
  }

  // Commit any remaining, then push once
  if (batch.length > 0) commitBatch(batch);
  if (added > 0) pushOnce();

  console.log(`\nDone. Added ${added} new bands.`);
}

main().catch(console.error);
