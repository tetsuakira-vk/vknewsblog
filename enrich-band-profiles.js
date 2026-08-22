/**
 * enrich-band-profiles.js — Enrich Jekyll band profiles using vk.gy + Claude Haiku
 *
 * Sources are VK-specific to avoid name collisions with non-VK artists:
 *   albums  → vk.gy (VK database, no false matches)
 *   tracks  → Claude Haiku (knows VK bands by name)
 *   youtube → YouTube search (existing OAuth)
 *
 * Flags (combine freely):
 *   --reset          Wipe existing top_albums and top_tracks before running
 *   --albums         Fill top_albums from vk.gy
 *   --tracks         Fill missing top_tracks via Claude Haiku
 *   --youtube        Add top YouTube video ID (uses existing OAuth)
 *   --all-fields     --albums + --tracks + --youtube
 *   --limit N        Process at most N bands
 *   --band "Name"    Process a single band (partial match OK)
 *   --dry            Preview changes without writing files
 *
 * Fix Last.fm collision damage:
 *   node enrich-band-profiles.js --reset --albums --tracks
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { google } from 'googleapis';
import * as cheerio from 'cheerio';
import path from 'path';
import { pushWithRebase } from './lib/jekyll.js';

const BANDS_DIR    = '/Users/robertnelson/vkchronicle/_bands';
const SITE_REPO    = '/Users/robertnelson/vkchronicle';
const COMMIT_EVERY = 20;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY         = args.includes('--dry');
const DO_RESET    = args.includes('--reset');
const DO_ALL      = args.includes('--all-fields');
const DO_TRACKS   = DO_ALL || args.includes('--tracks');
const DO_ALBUMS   = DO_ALL || args.includes('--albums');
const DO_YOUTUBE  = DO_ALL || args.includes('--youtube');
const limitIdx    = args.indexOf('--limit');
const MAX         = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const bandIdx     = args.indexOf('--band');
const BAND_FILTER = bandIdx !== -1 ? args[bandIdx + 1]?.toLowerCase() : null;

// ─── Front-matter helpers ─────────────────────────────────────────────────────

function parseBandFile(filepath) {
  const raw = readFileSync(filepath, 'utf8');
  const parts = raw.split('---');
  if (parts.length < 3) return null;
  const fm   = parts[1];
  const body = parts.slice(2).join('---').trim();

  const get = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*"([^"]*)"`, 'm'))
           || fm.match(new RegExp(`^${key}:\\s*([^\\n"'\\[]+)`, 'm'));
    return m ? m[1].trim() : null;
  };

  const getList = (key) => {
    const block = fm.match(new RegExp(`^${key}:\\s*\\n((?:  - [^\\n]+\\n?)+)`, 'm'));
    if (block) return block[1].match(/  - "?([^"\n]+)"?/g)
      ?.map(l => l.replace(/  - "?|"$/g, '').trim()) || [];
    return [];
  };

  return {
    filepath,
    name:       get('name'),
    lastfmSlug: get('lastfm_slug'),
    topTracks:  getList('top_tracks'),
    topAlbums:  getList('top_albums'),
    youtubeId:  get('youtube_id'),
    body,
    raw,
  };
}

function removeFrontMatterKey(raw, key) {
  const parts = raw.split('---');
  if (parts.length < 3) return raw;
  // Remove block lists
  parts[1] = parts[1].replace(new RegExp(`^${key}:\\n(?:  - [^\\n]+\\n)+`, 'm'), '');
  // Remove scalar values
  parts[1] = parts[1].replace(new RegExp(`^${key}:[^\\n]*\\n`, 'm'), '');
  return parts.join('---');
}

function updateFrontMatter(raw, updates) {
  const parts = raw.split('---');
  if (parts.length < 3) return raw;
  let fm = parts[1];

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      const block = `${key}:\n${value.map(v => `  - "${v.replace(/"/g, '\\"')}"`).join('\n')}\n`;
      const existing = new RegExp(`^${key}:\\n(?:  - [^\\n]+\\n)+`, 'm');
      if (existing.test(fm)) {
        fm = fm.replace(existing, block);
      } else {
        fm = fm.replace(new RegExp(`^${key}:[^\\n]*\\n`, 'm'), '');
        fm = fm.trimEnd() + '\n' + block;
      }
    } else {
      const line = `${key}: "${String(value).replace(/"/g, '\\"')}"`;
      const existing = new RegExp(`^${key}:\\s*[^\\n]*`, 'm');
      if (existing.test(fm)) {
        fm = fm.replace(existing, line);
      } else {
        fm = fm.trimEnd() + '\n' + line + '\n';
      }
    }
  }

  parts[1] = fm;
  return parts.join('---');
}

// ─── vk.gy scraping ───────────────────────────────────────────────────────────

// Words in release titles that indicate non-album releases
const RELEASE_SKIP = /\b(live|dvd|blu[- ]?ray|tokuten|omnibus|demo|promo|bootleg|interview|digest|making|gig|best|photo|anniversary|oneman|concert|compilation|selected|clips?|documentary|selection|history|box)\b|\btour\w*|\bcollection\b|\bvol\.\s*\d|UNDEAD\s+Vol|@[A-Z]|\d{4}\/\d{2}\/\d{2}|\d{2,4}[~]\d{2,4}|\d{4}-\d{4}|^\d{4}[.\-]\d|\bat\d|\s+at\s+[A-Z0-9]|【[^】]*\d{4}/i;

function bandNameToVkgySlug(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchVkgyAlbums(bandName) {
  const slug = bandNameToVkgySlug(bandName);
  const url  = `https://vk.gy/artists/${slug}/`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { albums: [], found: false };

    const $ = cheerio.load(await res.text());
    const seen = new Set();
    const releases = [];

    $('.history__content.release').each((_, el) => {
      const a    = $(el).find('a').first();
      const href = a.attr('href') || '';
      if (href.includes('/omnibus/')) return; // skip compilation appearances

      const enEl = a.find('.any--en').first();
      const title = (enEl.length ? enEl.text() : a.text()).trim();
      if (!title || RELEASE_SKIP.test(title)) return;

      const date = $(el).closest('li').find('.history__date').text().trim();
      const key  = title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        releases.push({ title, date: date || '0000' });
      }
    });

    // Most recent first, take top 5
    releases.sort((a, b) => b.date.localeCompare(a.date));
    return { albums: releases.slice(0, 5).map(r => r.title), found: true };
  } catch {
    return { albums: [], found: false };
  }
}

// ─── Claude Haiku — top tracks ────────────────────────────────────────────────

async function generateTopTracks(anthropic, bandName) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `List 3 well-known song titles by the Japanese Visual Kei band "${bandName}". Reply with just the 3 titles, one per line, no numbering. If you don't know any songs, reply: UNKNOWN`,
    }],
  });
  const text = msg.content[0]?.text?.trim() || '';
  if (!text || text.startsWith('UNKNOWN')) return [];
  return text.split('\n').map(t => t.trim()).filter(Boolean).slice(0, 3);
}

// ─── YouTube search ───────────────────────────────────────────────────────────

function getYouTubeClient() {
  const auth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth });
}

async function fetchYouTubeVideoId(youtube, bandName) {
  try {
    const res = await youtube.search.list({
      part: ['snippet'],
      q: `${bandName} official MV`,
      type: ['video'],
      order: 'viewCount',
      maxResults: 3,
      videoCategoryId: '10',
    });
    const items = res.data.items || [];
    const name  = bandName.toLowerCase();
    const ranked = items.sort((a, b) => {
      const aM = (a.snippet.title + a.snippet.channelTitle).toLowerCase().includes(name) ? 0 : 1;
      const bM = (b.snippet.title + b.snippet.channelTitle).toLowerCase().includes(name) ? 0 : 1;
      return aM - bM;
    });
    return ranked[0]?.id?.videoId || null;
  } catch { return null; }
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function commitBatch(slugs) {
  try {
    const files = slugs.map(s => `"_bands/${s}"`).join(' ');
    execSync(
      `git -C "${SITE_REPO}" add ${files} && git -C "${SITE_REPO}" commit -m "Enrich ${slugs.length} band profiles (vk.gy + Haiku)"`,
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
  if (!DO_ALBUMS && !DO_TRACKS && !DO_YOUTUBE && !DO_RESET) {
    console.error('Specify at least one flag: --reset --albums --tracks --youtube --all-fields');
    process.exit(1);
  }

  const anthropic = DO_TRACKS ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  const youtube   = DO_YOUTUBE ? getYouTubeClient() : null;

  const files = readdirSync(BANDS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(BANDS_DIR, f));

  const bands   = files.map(parseBandFile).filter(Boolean);
  const targets = BAND_FILTER
    ? bands.filter(b => b.name?.toLowerCase().includes(BAND_FILTER))
    : bands;

  const toProcess = targets.slice(0, MAX);
  console.log(`Processing ${toProcess.length} band(s)${DRY ? ' — DRY RUN' : ''}\n`);

  let changed = 0;
  let batch   = [];

  for (const band of toProcess) {
    console.log(`[${changed + batch.length + 1}] ${band.name}`);
    let content      = band.raw;
    let didSomething = false;

    // ── Reset ────────────────────────────────────────────────────────────────
    if (DO_RESET) {
      const before = content;
      content = removeFrontMatterKey(content, 'top_albums');
      content = removeFrontMatterKey(content, 'top_tracks');
      if (content !== before) {
        console.log(`  → Cleared existing albums/tracks`);
        didSomething = true;
      }
      // Re-parse after wipe so downstream steps see empty lists
      band.topAlbums = [];
      band.topTracks = [];
    }

    // ── Albums from vk.gy ────────────────────────────────────────────────────
    if (DO_ALBUMS && !band.topAlbums?.length) {
      const { albums, found } = await fetchVkgyAlbums(band.name);
      await sleep(500);
      if (albums.length) {
        content = updateFrontMatter(content, { top_albums: albums });
        console.log(`  ✓ Albums (vk.gy): ${albums.join(', ')}`);
        didSomething = true;
      } else {
        console.log(`  → No albums on vk.gy${found ? ' (all filtered)' : ' (band not found)'}`);
      }
    } else if (DO_ALBUMS) {
      console.log(`  → Albums already set, skipping`);
    }

    // ── Tracks via Claude Haiku ───────────────────────────────────────────────
    if (DO_TRACKS && !band.topTracks?.length) {
      const tracks = await generateTopTracks(anthropic, band.name);
      await sleep(300);
      if (tracks.length) {
        content = updateFrontMatter(content, { top_tracks: tracks });
        console.log(`  ✓ Tracks (Haiku): ${tracks.join(', ')}`);
        didSomething = true;
      } else {
        console.log(`  → Haiku returned no tracks`);
      }
    } else if (DO_TRACKS) {
      console.log(`  → Tracks already set, skipping`);
    }

    // ── YouTube ───────────────────────────────────────────────────────────────
    if (DO_YOUTUBE && !band.youtubeId) {
      const vid = await fetchYouTubeVideoId(youtube, band.name);
      await sleep(500);
      if (vid) {
        content = updateFrontMatter(content, { youtube_id: vid });
        console.log(`  ✓ YouTube: https://youtu.be/${vid}`);
        didSomething = true;
      } else {
        console.log(`  → No YouTube video found`);
      }
    } else if (DO_YOUTUBE) {
      console.log(`  → YouTube already set, skipping`);
    }

    if (!didSomething) continue;
    if (DRY) { console.log('  [dry] Would update file'); continue; }

    writeFileSync(band.filepath, content, 'utf8');
    batch.push(path.basename(band.filepath));

    if (batch.length >= COMMIT_EVERY) {
      commitBatch(batch);
      changed += batch.length;
      batch = [];
    }

    await sleep(200);
  }

  if (batch.length > 0 && !DRY) {
    commitBatch(batch);
    changed += batch.length;
  }
  if (changed > 0 && !DRY) pushOnce();

  console.log(`\nDone. ${changed} band file(s) updated.`);
}

main().catch(err => { console.error(err); process.exit(1); });
