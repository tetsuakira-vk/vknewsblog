/**
 * livefans-pipeline.js
 * Scrapes recent Visual Kei setlists from livefans.jp.
 *
 * Strategy: for each VK band in _bands/, look up their livefans.jp artist ID
 * (cached in livefans-ids.json), then fetch /artists/past/{id} to find events
 * that have confirmed setlists, then parse each event page.
 *
 * Usage:
 *   node livefans-pipeline.js              # process all known bands (default 2 past pages each)
 *   node livefans-pipeline.js --pages 5    # look further back per band
 *   node livefans-pipeline.js --dry        # preview without writing
 *   node livefans-pipeline.js --limit 20   # cap total posts
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { pushWithRebase } from './lib/jekyll.js';

const SITE_REPO    = process.env.SITE_REPO_PATH || '/Users/robertnelson/vkchronicle';
const POSTS_DIR    = `${SITE_REPO}/_setlists`;
const BANDS_DIR    = `${SITE_REPO}/_bands`;
const TRACKING     = '/Users/robertnelson/vknewsblog/posted-livefans.json';
const ID_CACHE     = '/Users/robertnelson/vknewsblog/livefans-ids.json';
const BASE_URL     = 'https://www.livefans.jp';
const COMMIT_EVERY = 5;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Args ─────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const DRY      = args.includes('--dry');
const pagesArg = args.indexOf('--pages');
const limitArg = args.indexOf('--limit');
const PAGES_PER_BAND = pagesArg !== -1 ? parseInt(args[pagesArg + 1], 10) : 2;
const MAX            = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : Infinity;
const daysArg  = args.indexOf('--days');
const MIN_DATE = daysArg !== -1
  ? new Date(Date.now() - parseInt(args[daysArg + 1], 10) * 86400000).toISOString().slice(0, 10)
  : null;

// ─── Tracking ─────────────────────────────────────────────────────────────────

function loadTracking() {
  if (!existsSync(TRACKING)) return {};
  try { return JSON.parse(readFileSync(TRACKING, 'utf8')); } catch { return {}; }
}
function saveTracking(t) { writeFileSync(TRACKING, JSON.stringify(t, null, 2), 'utf8'); }

function loadIdCache() {
  if (!existsSync(ID_CACHE)) return {};
  try { return JSON.parse(readFileSync(ID_CACHE, 'utf8')); } catch { return {}; }
}
function saveIdCache(c) { writeFileSync(ID_CACHE, JSON.stringify(c, null, 2), 'utf8'); }

// ─── Local VK band list ────────────────────────────────────────────────────────

function loadBands() {
  const bands = []; // { name, slug }
  if (!existsSync(BANDS_DIR)) return bands;
  for (const file of readdirSync(BANDS_DIR)) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = readFileSync(path.join(BANDS_DIR, file), 'utf8');
      const m = raw.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
      if (m) bands.push({ name: m[1].trim(), slug: file.replace('.md', '') });
    } catch {}
  }
  return bands;
}

// ─── HTTP helper ───────────────────────────────────────────────────────────────

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.9' },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Artist ID lookup via livefans.jp alphabet index ─────────────────────────
// Letter index IDs: A=47, B=48, ... Z=72

function letterIndexId(bandName) {
  const first = bandName.replace(/^the\s+/i, '').trim().toUpperCase().charAt(0);
  if (first >= 'A' && first <= 'Z') return 47 + (first.charCodeAt(0) - 65);
  return null; // Japanese / numeric names not handled here
}

async function findArtistId(bandName, idCache) {
  const cacheKey = bandName.toLowerCase();
  if (idCache[cacheKey] !== undefined) return idCache[cacheKey]; // null means "not found"

  const letterId = letterIndexId(bandName);
  if (!letterId) { idCache[cacheKey] = null; return null; }

  const search = bandName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  for (let page = 1; page <= 5; page++) {
    const url = page === 1
      ? `${BASE_URL}/artist/search/all/${letterId}`
      : `${BASE_URL}/artist/search/all/${letterId}/page:${page}`;

    let html;
    try {
      html = await get(url);
      await sleep(3000);
    } catch { break; }

    const $ = cheerio.load(html);

    // Check if this page has any results
    if (!$('h3.artistName').length) break;

    let found = null;
    $('h3.artistName a').each((_, el) => {
      if (found) return;
      const name = $(el).text().trim();
      if (name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim() === search) {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/artists\/(\d+)/);
        if (m) found = m[1];
      }
    });

    if (found) {
      console.log(`  Found ${bandName} → artist ID ${found}`);
      idCache[cacheKey] = found;
      return found;
    }
  }

  idCache[cacheKey] = null;
  return null;
}

// ─── Past events listing parser ───────────────────────────────────────────────

function parsePastEvents(html) {
  const $ = cheerio.load(html);
  const events = [];

  $('.whiteBack.midBox').each((_, el) => {
    // Only events that have a confirmed setlist (セットリスト link)
    if (!$(el).find('span.ticon.list').length) return;

    const href  = $(el).find('a[href^="/events/"]').first().attr('href') || '';
    const eventId = href.match(/\/events\/(\d+)/)?.[1];
    if (!eventId) return;

    const dateRaw = $(el).find('p.date').first().text().trim();
    const dm = dateRaw.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    const showDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;

    // Skip future events — no setlist will exist yet
    if (showDate && showDate > new Date().toISOString().slice(0, 10)) return;
    // Skip events older than --days cutoff
    if (MIN_DATE && showDate && showDate < MIN_DATE) return;

    events.push({ eventId, showDate });
  });

  return events;
}

// ─── Event page parser ────────────────────────────────────────────────────────

function parseEventPage(html) {
  const $ = cheerio.load(html);

  // Artist, venue, date, tour from form fields
  const artist = $('input[name="data[event][artist_name_1]"]').last().val()?.trim() || '';
  const venue  = $('input[name="data[event][place_name]"]').last().val()?.trim()
    || $('address a').first().text().trim().replace(/^＠/, '').trim();
  const dateRaw = $('input[name="data[event][holding_date]"]').last().val()?.trim() || '';
  const tour   = $('input[name="data[event][tour]"]').last().val()?.trim() || '';

  // Parse date "2026/04/30" → "2026-04-30"
  const dm = dateRaw.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  const showDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;

  // Songs — walk td.pcsl* elements in order
  const songs = [];
  const encoreSongs = [];
  let inEncore = false;

  $('td[class*="pcsl"]').each((_, el) => {
    const $el = $(el);
    // Encore marker: <strong>アンコール：</strong> inside this td
    if ($el.find('strong').text().includes('アンコール')) inEncore = true;
    const title = $el.find('div.ttl a').first().text().trim();
    if (title) (inEncore ? encoreSongs : songs).push(title);
  });

  return { artist, venue, showDate, tour, songs, encoreSongs };
}

// ─── Romaji map — append "(Romaji)" when artist name is Japanese-only ─────────

const ROMAJI_MAP = {
  'ギルガメッシュ':    'Girugamesh',
  '己龍':              'Kiryu',
  'シド':              'SID',
  '摩天楼オペラ':     'Matenrou Opera',
  'ナイトメア':        'Nightmare',
  'ヴィドール':        'Vidoll',
  'ルシファーズハンマー': "Lucifer's Hammer",
  'メリー':            'MERRY',
  'ペニシリン':        'Penicillin',
  '黒夢':              'Kuroyume',
  '椎名林檎':          'Shiina Ringo',
  'オムニ同伴楽団':   'Onmyoza',
};

function hasJapanese(s) {
  return /[぀-ヿ一-鿿]/.test(s);
}

function addRomaji(name) {
  if (!hasJapanese(name)) return name;
  const ro = ROMAJI_MAP[name];
  return ro ? `${name} (${ro})` : name;
}

// ─── Jekyll post writer ────────────────────────────────────────────────────────

const MONTHS_EN = ['January','February','March','April','May','June','July',
                   'August','September','October','November','December'];

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 50);
}

function writePost(artist, showDate, venue, tour, songs, encoreSongs, sourceUrl) {
  const dateStr    = showDate || new Date().toISOString().slice(0, 10);
  const [y, m, d]  = dateStr.split('-').map(Number);
  const showDateEn = `${MONTHS_EN[m - 1]} ${d}, ${y}`;

  const titleSlug = slugify(`${artist}-setlist-${venue || 'live'}`);
  const filename  = `${dateStr}-${titleSlug}.md`;
  const filepath  = path.join(POSTS_DIR, filename);

  if (existsSync(filepath)) return null;

  const displayTitle = `${artist} Setlist — ${venue || 'Live'} (${showDateEn})`;
  const songList     = songs.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const encoreList   = encoreSongs.length
    ? `\n## Encore\n\n${encoreSongs.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const safe = s => (s || '').replace(/"/g, '\\"');

  const content = `---
layout: post
title: "${safe(displayTitle)}"
date: ${dateStr}
labels: [Setlists, "${safe(artist)}"]
band: "${safe(artist)}"
venue: "${safe(venue)}"
tour: "${safe(tour)}"
song_count: ${songs.length + encoreSongs.length}
source_url: ${sourceUrl}
source_name: livefans.jp
---

${tour ? `**Tour/Event:** ${tour}  \n` : ''}**Venue:** ${venue || '—'}
**Date:** ${showDateEn}
**Songs:** ${songs.length + encoreSongs.length}${encoreSongs.length ? ` (including ${encoreSongs.length}-song encore)` : ''}

## Setlist

${songList}
${encoreList}
*Setlist via [livefans.jp](${sourceUrl})*
`;

  writeFileSync(filepath, content, 'utf8');
  return filename;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function commitBatch(filenames) {
  try {
    const files = filenames.map(f => `"_setlists/${f}"`).join(' ');
    execSync(
      `git -C "${SITE_REPO}" add ${files} && git -C "${SITE_REPO}" commit -m "Add ${filenames.length} VK setlist(s) from livefans.jp"`,
      { stdio: 'pipe' }
    );
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const tracking = loadTracking();
  const idCache  = loadIdCache();
  const bands    = loadBands();

  console.log(`${bands.length} VK bands loaded, ${Object.keys(tracking).length} events already tracked\n`);

  let published = 0;
  let batch     = [];

  for (const band of bands) {
    if (published >= MAX) break;

    // Step 1: find livefans artist ID
    let artistId = idCache[band.name.toLowerCase()];
    if (artistId === undefined) {
      artistId = await findArtistId(band.name, idCache);
      saveIdCache(idCache);
      await sleep(3000);
    }

    if (!artistId) {
      // ID not found or not on livefans — skip silently
      continue;
    }

    // Step 2: fetch past events pages
    for (let page = 1; page <= PAGES_PER_BAND; page++) {
      if (published >= MAX) break;

      const listUrl = page === 1
        ? `${BASE_URL}/artists/past/${artistId}`
        : `${BASE_URL}/artists/past/${artistId}/page:${page}`;

      let listHtml;
      try {
        listHtml = await get(listUrl);
        await sleep(3000);
      } catch (err) {
        console.warn(`  ${band.name} page ${page} failed: ${err.message}`);
        break;
      }

      const events = parsePastEvents(listHtml);
      if (events.length === 0) break; // no more past events with setlists

      for (const ev of events) {
        if (published >= MAX) break;
        if (tracking[ev.eventId]) continue;

        const eventUrl = `${BASE_URL}/events/${ev.eventId}`;

        let eventHtml;
        try {
          eventHtml = await get(eventUrl);
          await sleep(3000);
        } catch (err) {
          console.warn(`  Event ${ev.eventId} failed: ${err.message}`);
          continue;
        }

        const { artist, venue, showDate, tour, songs, encoreSongs } = parseEventPage(eventHtml);

        if (songs.length === 0) {
          tracking[ev.eventId] = { skipped: true, reason: 'no_songs', band: band.name };
          continue;
        }

        const displayBand = addRomaji(artist || band.name);
        console.log(`  ✓ ${displayBand} — ${venue} (${showDate}) — ${songs.length + encoreSongs.length} songs`);

        if (DRY) {
          console.log(`    [dry] ${songs.slice(0, 3).join(', ')}${songs.length > 3 ? '...' : ''}`);
          published++;
          continue;
        }

        const filename = writePost(displayBand, showDate, venue, tour, songs, encoreSongs, eventUrl);
        if (!filename) {
          tracking[ev.eventId] = { skipped: true, reason: 'file_exists' };
          continue;
        }

        tracking[ev.eventId] = { published: true, filename, date: new Date().toISOString() };
        saveTracking(tracking);

        batch.push(filename);
        published++;

        if (batch.length >= COMMIT_EVERY) {
          commitBatch(batch);
          pushOnce();
          batch = [];
        }
      }
    }

    saveTracking(tracking);
    saveIdCache(idCache);
  }

  if (batch.length > 0 && !DRY) commitBatch(batch);
  if (published > 0 && !DRY) pushOnce();

  saveTracking(tracking);
  saveIdCache(idCache);
  console.log(`\nDone. ${published} setlist(s) published.`);
}

main().catch(err => { console.error(err); process.exit(1); });
