/**
 * update-band-tags.js
 * Scrapes vk.gy for each band's genre/subgenre tags and rewrites the
 * `tags` field in every _bands/*.md front matter.
 *
 * Slug resolution order:
 *   1. band-slugs.json override map
 *   2. Direct file slug
 *   3. Normalisation variants (apostrophes, accents, hyphens)
 *   4. vk.gy search fallback (saves resolved slug back to band-slugs.json)
 *
 * Tag priority: visual kei → kei subgenres → music genre descriptors
 * Skipped: rock, pop, major, indie, popular-overseas, needs-review, non-visual
 *
 * Usage: node update-band-tags.js
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';

const BANDS_DIR      = '/Users/robertnelson/vkchronicle/_bands';
const SLUG_MAP_FILE  = 'band-slugs.json';
const VKGY_BASE      = 'https://vk.gy/artists';
const DELAY_MS       = 1200;

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

function loadSlugMap() {
  if (!existsSync(SLUG_MAP_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(SLUG_MAP_FILE, 'utf8'));
    const { _comment, ...slugs } = data;
    return slugs;
  } catch { return {}; }
}

function saveSlugMap(map) {
  const existing = JSON.parse(readFileSync(SLUG_MAP_FILE, 'utf8'));
  writeFileSync(SLUG_MAP_FILE, JSON.stringify({ ...existing, ...map }, null, 2));
}

// Generate normalisation variants for a file slug.
// Covers the most common VK naming edge cases:
//   - apostrophes turned into hyphens (d-erlanger → derlanger)
//   - accented chars dropped to ascii (emmur-e → emmuree)
//   - leading article collapsed (l-arc-en-ciel → larc-en-ciel)
function slugVariants(fileSlug) {
  const variants = new Set([fileSlug]);
  // Remove all hyphens (catches apostrophe-collapsed slugs)
  variants.add(fileSlug.replace(/-/g, ''));
  // Remove leading single-char segment (d-band → band, l-arc → larc-en-ciel won't help but no harm)
  const withoutLeader = fileSlug.replace(/^[a-z]-/, '');
  if (withoutLeader !== fileSlug) variants.add(withoutLeader);
  // Collapse double-hyphens or trailing hyphens
  variants.add(fileSlug.replace(/--+/g, '-').replace(/-$/, ''));
  return [...variants].filter(v => v.length > 0);
}

async function checkSlug(slug) {
  try {
    const res = await fetch(`${VKGY_BASE}/${slug}/`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    return res.ok ? slug : null;
  } catch { return null; }
}

// Search vk.gy for a band name, return the resolved slug if found.
// Saves the mapping to band-slugs.json for future runs.
async function searchVkgySlug(fileSlug, bandName) {
  try {
    const res = await fetch(`https://vk.gy/search/artists/?q=${encodeURIComponent(bandName)}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    // Artist links on search results: /artists/{slug}/
    let found = null;
    $('a[href^="/artists/"]').each((_, el) => {
      if (found) return;
      const href = $(el).attr('href') || '';
      const m = href.match(/^\/artists\/([^/]+)\/?$/);
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
  // 1. Explicit override
  if (slugMap[fileSlug]) return slugMap[fileSlug];

  // 2. Direct slug
  if (await checkSlug(fileSlug)) return fileSlug;

  // 3. Normalisation variants
  for (const v of slugVariants(fileSlug)) {
    if (v === fileSlug) continue;
    if (await checkSlug(v)) {
      console.log(`    (normalisation resolved: "${fileSlug}" → "${v}")`);
      saveSlugMap({ [fileSlug]: v });
      return v;
    }
  }

  // 4. vk.gy search fallback
  return await searchVkgySlug(fileSlug, bandName);
}

// ─── Tag vocabulary ───────────────────────────────────────────────────────────

const TAG_MAP = {
  'osare-kei':      'oshare kei',
  'kote-kei':       'kote kei',
  'koteosa-kei':    'koteosa kei',
  'nagoya-kei':     'nagoya kei',
  'loud-kei':       'loud kei',
  'misshitsu-kei':  'misshitsu kei',
  'tanbi-kei':      'tanbi kei',
  'kurofuku-kei':   'kurofuku kei',
  'okeshou-kei':    'okeshou kei',
  'soft-visual-kei':'soft visual kei',
  'eroguro-kei':    'eroguro kei',
  'angura-kei':     'angura kei',
  'menhera-kei':    'menhera kei',
  'shironuri-kei':  'shironuri kei',
  'wafuu-kei':      'wafuu kei',
  'gothic':         'gothic',
  'industrial':     'industrial',
  'experimental':   'experimental',
  'digital':        'digital rock',
  'metal':          'metal',
  'nu-metal':       'nu-metal',
  'core':           'hardcore',
  'punk':           'punk',
  'jazz':           'jazz',
  'glam':           'glam rock',
  'beat-rock':      'beat rock',
};

const KEI_SLUGS = new Set([
  'osare-kei','kote-kei','koteosa-kei','nagoya-kei','loud-kei',
  'misshitsu-kei','tanbi-kei','kurofuku-kei','okeshou-kei',
  'soft-visual-kei','eroguro-kei','angura-kei','menhera-kei',
  'shironuri-kei','wafuu-kei',
]);

const SKIP_TAGS = new Set([
  'rock','pop','major','indie','popular-overseas','needs-review','non-visual',
]);

async function fetchVkgyTags(vkgySlug) {
  try {
    const res = await fetch(`${VKGY_BASE}/${vkgySlug}/`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const slugs = [...html.matchAll(/href="\/search\/artists\/\?tags\[\]=([^"]+)"/g)]
      .map(m => m[1]);
    return [...new Set(slugs)];
  } catch { return null; }
}

function buildTags(vkgySlugs) {
  const keiTags = [], genreTags = [];
  for (const slug of vkgySlugs) {
    if (SKIP_TAGS.has(slug)) continue;
    const display = TAG_MAP[slug];
    if (!display) continue;
    (KEI_SLUGS.has(slug) ? keiTags : genreTags).push(display);
  }
  return ['visual kei', ...keiTags, ...genreTags];
}

function setTagsFrontMatter(raw, tags) {
  const yamlTags = JSON.stringify(tags);
  if (/^tags:/m.test(raw)) return raw.replace(/^tags:.*$/m, `tags: ${yamlTags}`);
  const fmEnd = raw.indexOf('\n---\n', 4);
  if (fmEnd === -1) return raw;
  return raw.slice(0, fmEnd) + `\ntags: ${yamlTags}` + raw.slice(fmEnd);
}

function getBandName(raw) {
  const m = raw.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  return m ? m[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const slugMap = loadSlugMap();
  const files = readdirSync(BANDS_DIR).filter(f => f.endsWith('.md')).sort();
  console.log(`Processing ${files.length} band files...\n`);

  let updated = 0, skipped = 0;

  for (const file of files) {
    const fileSlug = file.replace('.md', '');
    const filePath = `${BANDS_DIR}/${file}`;
    const raw = readFileSync(filePath, 'utf8');
    const bandName = getBandName(raw) || fileSlug;

    process.stdout.write(`${fileSlug} → `);

    const vkgySlug = await resolveSlug(fileSlug, bandName, slugMap);
    if (!vkgySlug) {
      console.log('slug not found — skipping');
      skipped++;
      await sleep(DELAY_MS);
      continue;
    }

    const tagSlugs = await fetchVkgyTags(vkgySlug);
    if (!tagSlugs || tagSlugs.length === 0) {
      console.log('no vk.gy tags — skipping');
      skipped++;
      await sleep(DELAY_MS);
      continue;
    }

    const tags = buildTags(tagSlugs);
    const newRaw = setTagsFrontMatter(raw, tags);

    if (newRaw === raw) {
      console.log(`unchanged (${tags.join(', ')})`);
    } else {
      writeFileSync(filePath, newRaw, 'utf8');
      console.log(`✓ ${tags.join(', ')}`);
      updated++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone — ${updated} updated, ${skipped} skipped (no vk.gy tag data).`);
}

main().catch(console.error);
