/**
 * setlist-pipeline.js
 * Scrapes Visual Kei setlists from dailysetlist.net (2014–2020 archive),
 * filters for VK bands using our local _bands/ collection,
 * and publishes as Jekyll posts to vkchronicle.
 *
 * Usage:
 *   node setlist-pipeline.js              # RSS page 1 only
 *   node setlist-pipeline.js --backfill   # paginate through many RSS pages
 *   node setlist-pipeline.js --dry        # preview without writing
 *   node setlist-pipeline.js --limit 10   # cap at N posts
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { pushWithRebase } from './lib/jekyll.js';

const SITE_REPO    = '/Users/robertnelson/vkchronicle';
const POSTS_DIR    = `${SITE_REPO}/_posts`;
const BANDS_DIR    = `${SITE_REPO}/_bands`;
const TRACKING     = 'posted-setlists.json';
const RSS_BASE     = 'https://dailysetlist.net/feed/';
const COMMIT_EVERY = 5;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const DRY           = args.includes('--dry');
const BACKFILL      = args.includes('--backfill');
const limitArg      = args.indexOf('--limit');
const MAX           = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : Infinity;
const MAX_PAGES     = BACKFILL ? 300 : 3;

// ─── Tracking ─────────────────────────────────────────────────────────────────

function loadTracking() {
  if (!existsSync(TRACKING)) return {};
  try { return JSON.parse(readFileSync(TRACKING, 'utf8')); } catch { return {}; }
}

function saveTracking(t) {
  writeFileSync(TRACKING, JSON.stringify(t, null, 2), 'utf8');
}

// ─── Local VK band list ────────────────────────────────────────────────────────

function loadLocalBandNames() {
  const names = new Set();
  if (!existsSync(BANDS_DIR)) return names;
  for (const file of readdirSync(BANDS_DIR)) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = readFileSync(path.join(BANDS_DIR, file), 'utf8');
      const m = raw.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
      if (m) {
        names.add(norm(m[1]));
        // Also add common alternate forms
        names.add(norm(m[1].replace(/^the\s+/i, '')));
      }
    } catch {}
  }
  return names;
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isVkBand(categoryName, localBands) {
  const n = norm(categoryName);
  if (localBands.has(n)) return true;
  // Also check without common prefixes/suffixes
  const stripped = n.replace(/^the/, '').replace(/^a/, '');
  return localBands.has(stripped);
}

// ─── RSS fetch ────────────────────────────────────────────────────────────────

async function fetchRssPage(page) {
  const url = page === 1 ? RSS_BASE : `${RSS_BASE}?paged=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── Setlist parser ────────────────────────────────────────────────────────────

const MONTHS_JA = { '1':'January','2':'February','3':'March','4':'April','5':'May',
  '6':'June','7':'July','8':'August','9':'September','10':'October','11':'November','12':'December' };

function parseContent(contentHtml, artist, pubDateStr) {
  const $ = cheerio.load(contentHtml);

  // Date from first <p> matching 年月日 pattern
  let showDate = null;
  let showDateEn = '';
  $('p').each((_, el) => {
    if (showDate) return;
    const t = $(el).text().trim();
    const m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m) {
      showDate = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
      showDateEn = `${MONTHS_JA[m[2]]} ${parseInt(m[3])}, ${m[1]}`;
    }
  });
  // Fallback to pubDate
  if (!showDate && pubDateStr) {
    const d = new Date(pubDateStr);
    if (!isNaN(d)) {
      showDate = d.toISOString().slice(0,10);
      showDateEn = d.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    }
  }

  // Tour/event name: p containing 「…」
  let tour = '';
  $('p').each((_, el) => {
    if (tour) return;
    const t = $(el).text().trim();
    if (t.match(/^[「《]/) || (t.includes('「') && !t.match(/\d{4}年/))) {
      tour = t.replace(/^「|」$/g, '').replace(/^《|》$/g, '').trim();
    }
  });

  // Venue: <p> tags before the setlist section, excluding those inside .waku and song-number lines
  let venue = '';
  const allP = [];
  $('p').each((_, el) => {
    if ($(el).closest('.waku').length) return;  // skip p tags inside waku div
    const t = $(el).text().trim();
    if (!t) return;
    if (t.match(/\d{4}年/)) return;             // date line
    if (t === artist) return;                   // artist name
    if (t.match(/^[「《]/)) return;              // tour name
    if (t.match(/^\d+[.)）．]/)) return;         // song number line
    if (t.match(/セットリスト|アンコール/)) return; // section headers
    allP.push(t);
  });
  const venueCandidates = allP.filter(p => p !== tour && p.length < 60);
  if (venueCandidates.length > 0) venue = venueCandidates[venueCandidates.length - 1];

  // Songs from .waku div
  const waku = $('.waku').first();
  const songs = [];
  const encoreSongs = [];
  let inEncore = false;

  if (waku.length) {
    // Get all text nodes and br-separated chunks
    const wakuHtml = waku.html() || '';
    const chunks = wakuHtml
      .split(/<br\s*\/?>/i)
      .map(chunk => cheerio.load(chunk).text().trim())
      .filter(Boolean);

    for (const chunk of chunks) {
      for (const line of chunk.split('\n').map(l => l.trim()).filter(Boolean)) {
        if (line.match(/アンコール|encore/i)) {
          inEncore = true;
          continue;
        }
        // Skip placeholder text and section headers
        if (line.match(/^[※＊\*]/) || line.match(/^本編|^リハーサル|随時掲載|セットリスト/)) continue;
        // Must start with a song number — "1.", "01.", "1）", "M1." etc.
        if (!line.match(/^\d+[.)）．]/)) continue;
        const cleaned = line.replace(/^\d+[.)）．]\s*/, '').trim();
        if (!cleaned) continue;
        (inEncore ? encoreSongs : songs).push(cleaned);
      }
    }
  }

  return { showDate, showDateEn, tour, venue, songs, encoreSongs };
}

// ─── Slug helpers ──────────────────────────────────────────────────────────────

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

// ─── Jekyll post writer ────────────────────────────────────────────────────────

function writePost(artist, showDate, showDateEn, venue, tour, songs, encoreSongs, sourceUrl) {
  const dateStr  = showDate || new Date().toISOString().slice(0,10);
  const titleSlug = slugify(`${artist}-setlist-${venue || 'live'}`);
  const filename  = `${dateStr}-${titleSlug}.md`;
  const filepath  = path.join(POSTS_DIR, filename);

  if (existsSync(filepath)) return null;

  const displayTitle = `${artist} Setlist — ${venue || 'Live'}${showDateEn ? ` (${showDateEn})` : ''}`;

  const songList = songs.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const encoreList = encoreSongs.length
    ? `\n## Encore\n\n${encoreSongs.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const content = `---
layout: post
title: "${displayTitle.replace(/"/g, '\\"')}"
date: ${dateStr}
labels: [Setlists, "${artist}"]
band: "${artist}"
venue: "${(venue || '').replace(/"/g, '\\"')}"
tour: "${(tour || '').replace(/"/g, '\\"')}"
song_count: ${songs.length + encoreSongs.length}
source_url: ${sourceUrl}
source_name: dailysetlist.net
---

${tour ? `**Tour/Event:** ${tour}  \n` : ''}**Venue:** ${venue || '—'}
**Date:** ${showDateEn || dateStr}
**Songs:** ${songs.length + encoreSongs.length}${encoreSongs.length ? ` (including ${encoreSongs.length}-song encore)` : ''}

## Setlist

${songList}
${encoreList}
*Setlist via [dailysetlist.net](${sourceUrl})*
`;

  writeFileSync(filepath, content, 'utf8');
  return filename;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function commitBatch(filenames) {
  try {
    const files = filenames.map(f => `"_posts/${f}"`).join(' ');
    execSync(`git -C "${SITE_REPO}" add ${files} && git -C "${SITE_REPO}" commit -m "Add ${filenames.length} VK setlist(s)"`, { stdio: 'pipe' });
    console.log(`  ✓ Committed ${filenames.length} posts`);
  } catch (err) {
    console.warn(`  Git error: ${err.stderr?.toString().slice(0, 120)}`);
  }
}

function pushOnce() {
  try {
    pushWithRebase();
    console.log('  ✓ Pushed to GitHub');
  } catch (err) {
    console.warn(`  Push error: ${err.stderr?.toString().slice(0, 120)}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const tracking   = loadTracking();
  const localBands = loadLocalBandNames();

  console.log(`Loaded ${localBands.size} local VK bands, ${Object.keys(tracking).length} already-tracked setlists\n`);

  let published = 0;
  let batch = [];
  let emptyPages = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (published >= MAX) break;

    let xml;
    try {
      xml = await fetchRssPage(page);
      await sleep(1500);
    } catch (err) {
      console.warn(`  Page ${page} failed: ${err.message} — retrying in 5s`);
      await sleep(5000);
      try {
        xml = await fetchRssPage(page);
        await sleep(1500);
      } catch (err2) {
        console.warn(`  Page ${page} retry failed — stopping`);
        break;
      }
    }

    const $ = cheerio.load(xml, { xmlMode: true });
    const items = $('item').toArray();

    if (items.length === 0) {
      console.log(`  Page ${page}: no items — stopping`);
      break;
    }

    let pageVkPublished = 0;
    let pageVkFound = 0;   // VK bands found (including placeholders)
    let pageNew = 0;       // untracked items actually evaluated this page

    for (const item of items) {
      if (published >= MAX) break;

      const url       = $('link', item).text().trim() || $('guid', item).text().trim();
      const title     = $('title', item).text().trim();
      const pubDate   = $('pubDate', item).text().trim();
      const category  = $('category', item).first().text().trim();
      const contentEl = $('content\\:encoded', item).text().trim();

      if (!url || tracking[url]) continue;
      pageNew++;

      if (!isVkBand(category, localBands)) {
        tracking[url] = { skipped: true, reason: 'not_vk', band: category };
        continue;
      }
      pageVkFound++;

      // Parse setlist
      const { showDate, showDateEn, tour, venue, songs, encoreSongs } = parseContent(contentEl, category, pubDate);

      if (songs.length === 0) {
        console.log(`  [skip] ${category} — no songs parsed (${title.slice(0,50)})`);
        tracking[url] = { skipped: true, reason: 'no_songs', band: category };
        continue;
      }

      console.log(`  ✓ ${category} — ${venue || '?'} (${showDate || '?'}) — ${songs.length + encoreSongs.length} songs`);

      if (DRY) {
        console.log(`    [dry] Would publish: ${category} at ${venue}`);
        tracking[url] = { skipped: true, reason: 'dry_run' };
        pageVkPublished++;
        continue;
      }

      const filename = writePost(category, showDate, showDateEn, venue, tour, songs, encoreSongs, url);
      if (!filename) {
        tracking[url] = { skipped: true, reason: 'file_exists' };
        continue;
      }

      tracking[url] = { published: true, filename, date: new Date().toISOString() };
      saveTracking(tracking);

      batch.push(filename);
      published++;
      pageVkPublished++;

      if (batch.length >= COMMIT_EVERY) {
        commitBatch(batch);
        pushOnce();
        batch = [];
      }
    }

    if (page % 10 === 0) {
      console.log(`  [page ${page}] ${published} published so far`);
      saveTracking(tracking);
    }

    // Only stop if we evaluated new items and found zero VK bands at all (not just empty setlists)
    if (pageNew > 0 && pageVkFound === 0 && page > 5) {
      emptyPages++;
      if (emptyPages >= 20) {
        console.log(`  20 consecutive non-VK pages — stopping`);
        break;
      }
    } else if (pageVkFound > 0) {
      emptyPages = 0;
    }
  }

  if (batch.length > 0 && !DRY) commitBatch(batch);
  if (published > 0 && !DRY) pushOnce();

  saveTracking(tracking);
  console.log(`\nDone. ${published} setlist(s) published.`);
}

main().catch(err => { console.error(err); process.exit(1); });
