/**
 * update-bands-page.js - Build and maintain the VK band directory
 *
 * - Seed list of ~70 major VK bands + dynamically discovered from CDJapan rankings
 * - Enriches each band with Last.fm data (photo, listener count, tags, bio)
 * - Writes individual _bands/*.md profile files and pushes in one batch commit
 * - Builds the main bands/index.html directory page with search + grid
 *
 * Cache: bands-cache.json (refreshed every 7 days per band)
 *
 * Usage: node update-bands-page.js [--limit=N]
 * Cron (weekly, Sunday 11am): 0 11 * * 0 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node update-bands-page.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { updateJekyllPage, batchUpdateJekyll, readdirSync, SITE_REPO_PATH } from './lib/jekyll.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const BATCH_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const CACHE_FILE = './bands-cache.json';
const CACHE_TTL_DAYS = 7;

// ─── Seed list ────────────────────────────────────────────────────────────────
// displayName: shown on page | lastfmSlug: Last.fm URL slug
const BAND_SEEDS = [
  // Legends / titans
  { displayName: 'Dir en grey',           lastfmSlug: 'Dir+en+grey' },
  { displayName: 'the GazettE',           lastfmSlug: 'the+GazettE' },
  { displayName: 'Buck-Tick',             lastfmSlug: 'Buck-Tick' },
  { displayName: 'Malice Mizer',          lastfmSlug: 'Malice+Mizer' },
  { displayName: 'LUNA SEA',              lastfmSlug: 'LUNA+SEA' },
  { displayName: 'X Japan',               lastfmSlug: 'X+Japan' },
  { displayName: "L'Arc-en-Ciel",         lastfmSlug: "L'Arc-en-Ciel" },
  { displayName: 'Versailles',            lastfmSlug: 'Versailles' },
  { displayName: 'Alice Nine',            lastfmSlug: 'Alice+Nine' },
  { displayName: 'Moi dix Mois',          lastfmSlug: 'Moi+dix+Mois' },
  { displayName: 'MUCC',                  lastfmSlug: 'MUCC' },
  { displayName: 'Nightmare',             lastfmSlug: 'Nightmare' },
  { displayName: 'An Cafe',               lastfmSlug: 'An+Cafe' },
  { displayName: 'Girugamesh',            lastfmSlug: 'Girugamesh' },
  { displayName: 'Plastic Tree',          lastfmSlug: 'Plastic+Tree' },
  { displayName: 'Kagrra',               lastfmSlug: 'Kagrra' },
  { displayName: 'SID',                   lastfmSlug: 'SID' },
  { displayName: 'The Novembers',         lastfmSlug: 'The+Novembers' },
  { displayName: 'Rentrer en Soi',        lastfmSlug: 'Rentrer+en+Soi' },
  { displayName: 'VAMPS',                 lastfmSlug: 'VAMPS' },
  { displayName: 'Gackt',                 lastfmSlug: 'Gackt' },
  { displayName: 'HYDE',                  lastfmSlug: 'HYDE' },
  { displayName: 'Miyavi',                lastfmSlug: 'Miyavi' },
  // Active 2010s–2020s
  { displayName: 'DIAURA',                lastfmSlug: 'DIAURA' },
  { displayName: 'NAZARE',                lastfmSlug: 'NAZARE' },
  { displayName: 'KIZU',                  lastfmSlug: 'KIZU' },
  { displayName: 'Royz',                  lastfmSlug: 'Royz' },
  { displayName: 'Codomo Dragon',         lastfmSlug: 'Codomo+Dragon' },
  { displayName: 'Razor',                 lastfmSlug: 'Razor' },
  { displayName: 'Jiluka',                lastfmSlug: 'Jiluka' },
  { displayName: 'Deviloof',              lastfmSlug: 'Deviloof' },
  { displayName: 'Megaromania',           lastfmSlug: 'Megaromania' },
  { displayName: 'Matenrou Opera',        lastfmSlug: 'Matenrou+Opera' },
  { displayName: 'Sadie',                 lastfmSlug: 'Sadie' },
  { displayName: 'Mejibray',              lastfmSlug: 'Mejibray' },
  { displayName: 'Scapegoat',             lastfmSlug: 'Scapegoat' },
  { displayName: 'Sarigia',               lastfmSlug: 'Sarigia' },
  { displayName: 'Xaa-Xaa',              lastfmSlug: 'Xaa-Xaa' },
  { displayName: 'Arlequin',              lastfmSlug: 'Arlequin' },
  { displayName: 'Cali≠gari',             lastfmSlug: 'Cali%E2%89%A0gari' },
  { displayName: 'Lycaon',                lastfmSlug: 'Lycaon' },
  { displayName: 'BORN',                  lastfmSlug: 'BORN' },
  { displayName: 'Deathgaze',             lastfmSlug: 'Deathgaze' },
  { displayName: 'D',                     lastfmSlug: 'D' },
  { displayName: 'Exist†trace',           lastfmSlug: 'Exist%E2%80%A0trace' },
  { displayName: 'Vidoll',                lastfmSlug: 'Vidoll' },
  { displayName: 'heidi.',                lastfmSlug: 'heidi.' },
  { displayName: 'Pentagon',              lastfmSlug: 'Pentagon' },
  { displayName: 'Baroque',               lastfmSlug: 'Baroque' },
  { displayName: 'Vistlip',               lastfmSlug: 'Vistlip' },
  { displayName: 'KRA',                   lastfmSlug: 'KRA' },
  { displayName: 'LM.C',                  lastfmSlug: 'LM.C' },
  { displayName: 'The Black Swan',        lastfmSlug: 'The+Black+Swan' },
  { displayName: 'Suicide Ali',           lastfmSlug: 'Suicide+Ali' },
  { displayName: 'Angelo',                lastfmSlug: 'Angelo' },
  { displayName: 'Develop One\'s Faculties', lastfmSlug: 'Develop+One\'s+Faculties' },
  { displayName: 'Petit Brabancon',       lastfmSlug: 'Petit+Brabancon' },
  { displayName: 'Sukekiyo',              lastfmSlug: 'Sukekiyo' },
  { displayName: 'DIMLIM',                lastfmSlug: 'DIMLIM' },
  { displayName: 'Dadaroma',              lastfmSlug: 'Dadaroma' },
  { displayName: 'Rides in ReVellion',    lastfmSlug: 'Rides+in+ReVellion' },
  { displayName: 'Umbrella',              lastfmSlug: 'Umbrella' },
  { displayName: 'Fatima',                lastfmSlug: 'Fatima' },
  { displayName: 'La:Sadie\'s',           lastfmSlug: "La%3ASadie's" },
  { displayName: 'lynch.',                lastfmSlug: 'lynch.' },
  { displayName: 'D=OUT',                 lastfmSlug: 'D%3DOUT' },
  { displayName: 'HANABIE.',              lastfmSlug: 'HANABIE.' },
  { displayName: 'Kiryu',                 lastfmSlug: 'Kiryu' },
];

function bandKey(name) { return name.toLowerCase().replace(/[\W]/g, ''); }
function bandSlug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function isCacheStale(entry) {
  if (!entry?.lastUpdated) return true;
  const age = (Date.now() - new Date(entry.lastUpdated).getTime()) / 86400000;
  return age > CACHE_TTL_DAYS;
}

// ─── Last.fm ──────────────────────────────────────────────────────────────────

async function fetchLastfmData(band) {
  const slug = band.lastfmSlug || encodeURIComponent(band.displayName);
  const url = `https://www.last.fm/music/${slug}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    let photo = null;
    const ogImg = $('meta[property="og:image"]').attr('content') || '';
    if (ogImg && !ogImg.includes('/meta/') && !ogImg.includes('placeholder') && !ogImg.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
      photo = ogImg;
    }
    if (!photo) {
      const bgStyle = $('.header-featured-image, .artist-header-featured-image, [class*="header"] [class*="featured"]').attr('style') || '';
      const bgMatch = bgStyle.match(/url\(['"]?([^'")\s]+)['"]?\)/);
      if (bgMatch && bgMatch[1] && !bgMatch[1].includes('placeholder')) photo = bgMatch[1];
    }
    if (!photo) {
      const headerImg = $('.header-featured-image img, .artist-header img').first().attr('src');
      if (headerImg && !headerImg.includes('placeholder')) photo = headerImg;
    }

    let listeners = 0;
    const listenerEl = $('.header-metadata .factbox-item, .header-metadata-tnew .factbox-item').filter((_, el) =>
      $(el).text().toLowerCase().includes('listener')
    );
    const abbrTitle = listenerEl.find('abbr').attr('title');
    if (abbrTitle) {
      listeners = parseInt(abbrTitle.replace(/[^0-9]/g, ''), 10) || 0;
    } else {
      const statText = listenerEl.find('.factbox-stat, abbr').first().text().trim();
      listeners = parseInt(statText.replace(/[^0-9]/g, '') || '0', 10) || 0;
    }

    const tags = [...new Set(
      $('.tag-list .tag, .tags-list .tag, [class*="tag"] a')
        .map((_, el) => $(el).text().trim().toLowerCase())
        .get()
        .filter(t => t && t.length > 1 && t.length < 30)
    )].slice(0, 4);

    const seenTracks = new Set();
    const topTracks = [];
    $('.chartlist-name a, .chartlist .chartlist-row .chartlist-name').each((_, el) => {
      const name = $(el).text().trim();
      if (name && !seenTracks.has(name) && topTracks.length < 5) {
        seenTracks.add(name);
        topTracks.push(name);
      }
    });

    let bio = '';
    const wikiEl = $('.wiki-summary p, .wiki-summary, .body-summary p, .artist-wiki p').first();
    const wikiText = wikiEl.text().replace(/\s+/g, ' ').trim();
    if (wikiText && !wikiText.startsWith('Listen to') && wikiText.length > 80) {
      bio = wikiText.slice(0, 500);
    }

    return { photo, listeners, tags, topTracks, bio, lastfmUrl: url };
  } catch { return null; }
}

async function generateBandBio(band, data) {
  try {
    const context = [
      `Band: ${band.displayName}`,
      data.tags?.length ? `Genre tags: ${data.tags.join(', ')}` : '',
      data.listeners > 0 ? `Last.fm listeners: ${data.listeners.toLocaleString()}` : '',
      data.topTracks?.length ? `Known songs: ${data.topTracks.slice(0, 3).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a 2-paragraph biography for the Japanese Visual Kei band/artist "${band.displayName}".

${context}

Write factually and engagingly. Cover their origin/formation, musical style, and significance in the VK scene.
Do not invent specific dates or albums you are not sure about — keep it general if needed.
Output only the bio text, no headings or labels.`,
      }],
    });
    return msg.content[0]?.text?.trim() || '';
  } catch { return ''; }
}

// ─── CDJapan — discover new artists from rankings ────────────────────────────

async function discoverArtistsFromCDJapan() {
  try {
    const res = await fetch('https://www.cdjapan.co.jp/music/j-pop/visualkei/?s=rank', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const artists = [];
    $('li').has('a.item-wrap').each((_, el) => {
      const artist = $(el).find('i.artist').first().text().trim();
      if (artist) artists.push(artist);
    });
    return [...new Set(artists)];
  } catch { return []; }
}

// ─── Recent posts for band backlinks ─────────────────────────────────────────

function loadRecentPosts() {
  try { return JSON.parse(readFileSync('./recent-posts.json', 'utf8')); } catch { return []; }
}

function findPostsForBand(bandName, allPosts) {
  const name = bandName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return allPosts
    .filter(p => p.title.toLowerCase().replace(/[^a-z0-9]/g, '').includes(name))
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, 5);
}

// ─── Existing band files ──────────────────────────────────────────────────────

function findExistingBandSlugs() {
  const bandsDir = path.join(SITE_REPO_PATH, '_bands');
  try {
    return new Set(
      readdirSync(bandsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -3))
    );
  } catch { return new Set(); }
}

// ─── Band profile markdown builder ───────────────────────────────────────────

function buildBandMarkdown(band, data, recentPosts = []) {
  const cdjapanUrl = `https://www.cdjapan.co.jp/searches?term.artist_name_search=${encodeURIComponent(band.displayName)}&genre=JPOP&subgenre_id=VK`;
  const safeStr = s => String(s).replace(/"/g, '\\"');

  // Deduplicate cached tags and tracks (scraper can return duplicates)
  const tags      = [...new Set(data.tags      || [])].slice(0, 4);
  const topTracks = [...new Set(data.topTracks || [])].slice(0, 5);

  // Strip any leading markdown heading from bio (old cached bios included "# BandName")
  const bio = (data.bio || '').replace(/^#+\s+[^\n]+\n+/, '').trim();

  let fm = '---\n';
  fm += `layout: band\n`;
  fm += `name: "${safeStr(band.displayName)}"\n`;
  if (data.photo) fm += `photo: "${safeStr(data.photo)}"\n`;
  if (tags.length) fm += `tags: [${tags.map(t => `"${safeStr(t)}"`).join(', ')}]\n`;
  if (data.listeners > 0) fm += `listeners: ${data.listeners}\n`;
  fm += `lastfm_slug: "${safeStr(band.lastfmSlug || encodeURIComponent(band.displayName))}"\n`;
  fm += `cdjapan_url: "${cdjapanUrl}"\n`;
  if (topTracks.length) {
    fm += `top_tracks:\n${topTracks.map(t => `  - "${safeStr(t)}"`).join('\n')}\n`;
  }
  if (recentPosts.length) {
    fm += `recent_news:\n${recentPosts.map(p => `  - url: "${p.url}"\n    title: "${safeStr(p.title)}"`).join('\n')}\n`;
  }
  fm += '---\n\n';

  return fm + bio + '\n';
}

// ─── Directory page ───────────────────────────────────────────────────────────

function buildDirectoryHtml(bands, cache, updatedAt) {
  const sorted = [...bands].sort((a, b) =>
    (cache[bandKey(b.displayName)]?.listeners || 0) - (cache[bandKey(a.displayName)]?.listeners || 0)
  );

  const cards = sorted.map(band => {
    const key = bandKey(band.displayName);
    const slug = bandSlug(band.displayName);
    const data = cache[key] || {};
    const photoHtml = data.photo
      ? `<img src="https://images.weserv.nl/?url=${encodeURIComponent(data.photo)}&w=200&output=jpg"
             alt="${band.displayName}"
             style="width:80px;height:80px;object-fit:cover;border-radius:50%;flex-shrink:0;background:#222;" />`
      : `<div style="width:80px;height:80px;border-radius:50%;background:rgba(255,255,255,0.07);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.5rem;">🎸</div>`;

    const topTag = data.tags?.[0] || 'Visual Kei';
    const listeners = data.listeners > 0
      ? `<span style="font-size:0.73rem;color:#888;">${(data.listeners / 1000).toFixed(0)}k listeners</span>`
      : '';

    return `<article class="band-card" data-name="${band.displayName.toLowerCase()}" data-tag="${(data.tags || []).join(' ').toLowerCase()}">
  ${photoHtml}
  <div class="band-info">
    <div class="band-name">${band.displayName}</div>
    <div class="band-meta"><span class="band-tag">${topTag}</span> ${listeners}</div>
    <a class="band-link" href="/bands/${slug}/">View profile →</a>
  </div>
</article>`;
  }).join('\n');

  return `<style>
  .bands-header { margin: 0 0 20px; }
  .bands-header h1 { margin: 0 0 6px; }
  .bands-header p { color: #bbb; margin: 0; font-size: 0.9rem; }
  #band-search { width: 100%; max-width: 400px; padding: 10px 14px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.05);
    color: inherit; font-size: 0.95rem; margin-bottom: 20px; box-sizing: border-box; }
  .bands-grid { display: grid; gap: 12px; grid-template-columns: repeat(12, 1fr); }
  .band-card { grid-column: span 12; display: flex; gap: 14px; align-items: center;
    border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
    background: rgba(255,255,255,0.02); padding: 12px; }
  @media (min-width: 540px) { .band-card { grid-column: span 6; } }
  @media (min-width: 900px) { .band-card { grid-column: span 4; } }
  .band-info { flex: 1; min-width: 0; }
  .band-name { font-size: 0.95rem; font-weight: 700; margin-bottom: 4px; }
  .band-meta { font-size: 0.78rem; margin-bottom: 6px; }
  .band-tag { display: inline-block; padding: 2px 8px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.12); color: #ccc; margin-right: 6px; }
  .band-link { font-size: 0.8rem; text-decoration: none; }
  .bands-footer { font-size: 0.8rem; color: #666; margin-top: 24px; }
  .band-card[hidden] { display: none; }
</style>
<div class="container" style="padding:40px 0;">
<div class="bands-header">
  <h1>Visual Kei Band Directory</h1>
  <p style="margin-bottom:6px;">Your home for Visual Kei bands worldwide — profiles, music, tour dates.</p>
  <p>${sorted.length} bands · sorted by popularity · updated ${updatedAt}</p>
</div>
<input id="band-search" type="search" placeholder="Search bands by name or genre..." oninput="
  var q = this.value.toLowerCase();
  document.querySelectorAll('.band-card').forEach(function(c) {
    c.hidden = q && !c.dataset.name.includes(q) && !c.dataset.tag.includes(q);
  });
" />
<div class="bands-grid">
${cards}
</div>
<p class="bands-footer">Updated ${updatedAt}.</p>
</div>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading band cache...');
  const cache = loadCache();

  console.log('Discovering artists from CDJapan rankings...');
  const cdArtists = await discoverArtistsFromCDJapan();
  const allBands = [...BAND_SEEDS];
  const seedKeys = new Set(BAND_SEEDS.map(b => bandKey(b.displayName)));
  for (const a of cdArtists) {
    if (a && !seedKeys.has(bandKey(a))) {
      allBands.push({ displayName: a, lastfmSlug: encodeURIComponent(a) });
      seedKeys.add(bandKey(a));
    }
  }
  console.log(`→ ${allBands.length} total bands (${BAND_SEEDS.length} seed + ${allBands.length - BAND_SEEDS.length} from CDJapan)`);

  // Fetch Last.fm data for stale/new bands
  let fetched = 0;
  for (const band of allBands) {
    const key = bandKey(band.displayName);
    if (!isCacheStale(cache[key])) continue;
    process.stdout.write(`  Fetching Last.fm: ${band.displayName}...`);
    const data = await fetchLastfmData(band);
    if (data) {
      cache[key] = { ...cache[key], ...data, displayName: band.displayName, lastfmSlug: band.lastfmSlug, lastUpdated: new Date().toISOString() };
      process.stdout.write(` ${data.listeners > 0 ? data.listeners.toLocaleString() + ' listeners' : 'no count'}\n`);
    } else {
      cache[key] = { ...cache[key], displayName: band.displayName, lastfmSlug: band.lastfmSlug, lastUpdated: new Date().toISOString() };
      process.stdout.write(` not found\n`);
    }
    fetched++;
    await new Promise(r => setTimeout(r, 800));
  }
  if (fetched > 0) {
    saveCache(cache);
    console.log(`→ Updated ${fetched} band entries in cache`);
  }

  // Generate Claude bios for bands with missing/thin bios
  console.log('Generating bios for bands without one...');
  let biosGenerated = 0;
  for (const band of allBands) {
    const key = bandKey(band.displayName);
    const entry = cache[key] || {};
    const bio = entry.bio || '';
    if (bio.length > 100 && !bio.startsWith('Listen to')) continue;
    process.stdout.write(`  Bio for ${band.displayName}...`);
    const generated = await generateBandBio(band, entry);
    if (generated) {
      cache[key] = { ...entry, bio: generated };
      process.stdout.write(` ✓\n`);
      biosGenerated++;
    } else {
      process.stdout.write(` skipped\n`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (biosGenerated > 0) {
    saveCache(cache);
    console.log(`→ Generated ${biosGenerated} bios`);
  }

  const allNewsPosts = loadRecentPosts();
  console.log(`→ ${allNewsPosts.length} recent posts loaded for backlinks`);

  const existingSlugs = findExistingBandSlugs();
  console.log(`→ ${existingSlugs.size} existing band files found`);

  // Build band markdown files
  const bandFiles = [];
  let created = 0, updated = 0, batchCount = 0;
  for (const band of allBands) {
    const key = bandKey(band.displayName);
    const slug = bandSlug(band.displayName);
    const data = cache[key] || {};
    const isNew = !existingSlugs.has(slug);

    if (isNew && batchCount >= BATCH_LIMIT) continue;

    const recentPosts = findPostsForBand(band.displayName, allNewsPosts);
    const content = buildBandMarkdown(band, data, recentPosts);
    bandFiles.push({ filePath: `_bands/${slug}.md`, content });

    if (isNew) { created++; batchCount++; } else { updated++; }
    process.stdout.write(`  ${isNew ? '✓ New' : '↻ Update'}: ${band.displayName}${recentPosts.length ? ` (${recentPosts.length} news links)` : ''}\n`);
  }

  if (bandFiles.length > 0) {
    batchUpdateJekyll(bandFiles, '"_bands/*.md"', 'Update band profiles');
    saveCache(cache);
    console.log(`→ Created: ${created}, Updated: ${updated}`);
  }

  // Build and publish the directory page
  console.log('Building directory page...');
  const updatedAt = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const html = buildDirectoryHtml(allBands, cache, updatedAt);

  updateJekyllPage(
    'bands/index.html',
    { layout: 'default', title: 'Visual Kei Band Directory', permalink: '/bands/' },
    html,
    'Update bands directory page',
  );
  console.log('✓ Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
