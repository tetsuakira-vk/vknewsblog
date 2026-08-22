/**
 * update-band-status.js
 * Scrapes vk.gy for each band's active/disbanded/paused status and writes
 * a `status` field into every _bands/*.md front matter.
 *
 * Slug resolution: band-slugs.json → direct slug → normalisation variants → vk.gy search
 *
 * Usage: node update-band-status.js
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';

const BANDS_DIR     = '/Users/robertnelson/vkchronicle/_bands';
const SLUG_MAP_FILE = '/Users/robertnelson/vknewsblog/band-slugs.json';
const VKGY_BASE     = 'https://vk.gy/artists';
const DELAY_MS      = 1200;

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

function loadSlugMap() {
  if (!existsSync(SLUG_MAP_FILE)) return {};
  try {
    const { _comment, ...slugs } = JSON.parse(readFileSync(SLUG_MAP_FILE, 'utf8'));
    return slugs;
  } catch { return {}; }
}

function saveSlugMap(additions) {
  const existing = JSON.parse(readFileSync(SLUG_MAP_FILE, 'utf8'));
  writeFileSync(SLUG_MAP_FILE, JSON.stringify({ ...existing, ...additions }, null, 2));
}

function slugVariants(fileSlug) {
  const variants = new Set([fileSlug]);
  variants.add(fileSlug.replace(/-/g, ''));
  const withoutLeader = fileSlug.replace(/^[a-z]-/, '');
  if (withoutLeader !== fileSlug) variants.add(withoutLeader);
  variants.add(fileSlug.replace(/--+/g, '-').replace(/-$/, ''));
  return [...variants].filter(v => v.length > 0);
}

async function checkSlug(slug) {
  try {
    const res = await fetch(`${VKGY_BASE}/${slug}/`, {
      headers: HEADERS, signal: AbortSignal.timeout(10000), redirect: 'follow',
    });
    return res.ok ? slug : null;
  } catch { return null; }
}

async function searchVkgySlug(fileSlug, bandName) {
  try {
    const res = await fetch(`https://vk.gy/search/artists/?q=${encodeURIComponent(bandName)}`, {
      headers: HEADERS, signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    let found = null;
    $('a[href^="/artists/"]').each((_, el) => {
      if (found) return;
      const m = ($(el).attr('href') || '').match(/^\/artists\/([^/]+)\/?$/);
      if (m && m[1] !== 'add') found = m[1];
    });
    if (found) {
      console.log(`    (search resolved: "${bandName}" → "${found}")`);
      saveSlugMap({ [fileSlug]: found });
    }
    return found;
  } catch { return null; }
}

async function resolveSlug(fileSlug, bandName, slugMap) {
  if (slugMap[fileSlug]) return slugMap[fileSlug];
  if (await checkSlug(fileSlug)) return fileSlug;
  for (const v of slugVariants(fileSlug)) {
    if (v === fileSlug) continue;
    if (await checkSlug(v)) {
      console.log(`    (normalisation resolved: "${fileSlug}" → "${v}")`);
      saveSlugMap({ [fileSlug]: v });
      return v;
    }
  }
  return await searchVkgySlug(fileSlug, bandName);
}

async function fetchStatus(vkgySlug) {
  try {
    const res = await fetch(`${VKGY_BASE}/${vkgySlug}/`, {
      headers: HEADERS, signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const text = $('.artist__status .any--en').first().text().trim().toLowerCase();
    if (!text || text === 'search') return null;
    return text;
  } catch { return null; }
}

function setFrontMatterField(raw, key, value) {
  const existing = new RegExp(`^${key}:.*$`, 'm');
  if (existing.test(raw)) return raw.replace(existing, `${key}: "${value}"`);
  const fmEnd = raw.indexOf('\n---\n', 4);
  if (fmEnd === -1) return raw;
  return raw.slice(0, fmEnd) + `\n${key}: "${value}"` + raw.slice(fmEnd);
}

function getBandName(raw) {
  const m = raw.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  return m ? m[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const slugMap = loadSlugMap();
  const files = readdirSync(BANDS_DIR).filter(f => f.endsWith('.md')).sort();
  console.log(`Processing ${files.length} band files...\n`);

  const results = { found: [], missing: [] };

  for (const file of files) {
    const fileSlug = file.replace(/\.md$/, '');
    const raw      = readFileSync(`${BANDS_DIR}/${file}`, 'utf8');
    const bandName = getBandName(raw) || fileSlug;

    const vkgySlug = await resolveSlug(fileSlug, bandName, slugMap);
    if (!vkgySlug) {
      console.log(`  ✗ ${fileSlug.padEnd(30)} → slug not found`);
      results.missing.push(fileSlug);
      await sleep(DELAY_MS);
      continue;
    }

    const bandStatus = await fetchStatus(vkgySlug);
    if (bandStatus) {
      const updated = setFrontMatterField(raw, 'status', bandStatus);
      writeFileSync(`${BANDS_DIR}/${file}`, updated, 'utf8');
      console.log(`  ✓ ${fileSlug.padEnd(30)} → ${bandStatus}`);
      results.found.push(fileSlug);
    } else {
      console.log(`  ✗ ${fileSlug.padEnd(30)} → status not found`);
      results.missing.push(fileSlug);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n✓ Done. ${results.found.length} updated, ${results.missing.length} not found:`);
  if (results.missing.length) console.log('  ' + results.missing.join(', '));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
