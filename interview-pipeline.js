/**
 * interview-pipeline.js
 * Fetches Visual Kei interviews from Japanese music sites, translates to English,
 * and publishes as Jekyll posts to vkchronicle.
 *
 * Sources:
 *   barks.jp        — RSS (VK-tagged feed), filter for V-ROCK category
 *   thefirsttimes.jp — RSS (interview feed), VK-validated via vk.gy
 *   natalie.mu      — HTML scrape, VK-validated via vk.gy
 *   spice.eplus.jp  — HTML scrape, VK-validated via vk.gy
 *
 * Usage:
 *   node interview-pipeline.js                  # latest page from all sources
 *   node interview-pipeline.js --backfill       # paginate back through archives (10 pages)
 *   node interview-pipeline.js --source barks   # single source
 *   node interview-pipeline.js --dry            # preview without writing
 *   node interview-pipeline.js --limit 3        # cap at N posts
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { pushWithRebase } from './lib/jekyll.js';

const SITE_REPO    = process.env.SITE_REPO_PATH || '/Users/robertnelson/vkchronicle';
const POSTS_DIR    = `${SITE_REPO}/_posts`;
const BANDS_DIR    = `${SITE_REPO}/_bands`;
const TRACKING     = '/Users/robertnelson/vknewsblog/posted-interviews.json';
const COMMIT_EVERY = 5;
const MIN_BODY_LEN = 600;   // chars — skip blurbs/short news items
const MAX_BODY_LEN = 12000; // chars — truncate very long pieces for translation

// ─── Args ─────────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const DRY           = args.includes('--dry');
const BACKFILL      = args.includes('--backfill');
const sourceArg     = args.indexOf('--source');
const SOURCE_FILTER = sourceArg !== -1 ? args[sourceArg + 1] : null;
const limitArg      = args.indexOf('--limit');
const MAX           = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : Infinity;
const MAX_PAGES     = BACKFILL ? 10 : 1;
const BACKFILL_CAP  = BACKFILL ? 20 : Infinity;

// ─── Tracking ─────────────────────────────────────────────────────────────────

function loadTracking() {
  if (!existsSync(TRACKING)) return {};
  try { return JSON.parse(readFileSync(TRACKING, 'utf8')); } catch { return {}; }
}

function saveTracking(data) {
  writeFileSync(TRACKING, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Local band list (fast pre-check) ─────────────────────────────────────────

function loadLocalBandNames() {
  const names = new Set();
  try {
    readdirSync(BANDS_DIR).filter(f => f.endsWith('.md')).forEach(f => {
      const raw = readFileSync(`${BANDS_DIR}/${f}`, 'utf8');
      const m = raw.match(/^name:\s*"([^"]+)"/m);
      if (m) names.add(m[1].toLowerCase().replace(/[^a-z0-9]/g, ''));
    });
  } catch {}
  return names;
}

// ─── VK validation via vk.gy ──────────────────────────────────────────────────

function toVkgySlug(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function isVkBand(bandName, localBands) {
  if (!bandName) return false;
  const norm = bandName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (localBands.has(norm)) return true;

  const slug = toVkgySlug(bandName);
  if (!slug || slug.length < 2) return false;
  try {
    const res = await fetch(`https://vk.gy/artists/${slug}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const html = await res.text();
    // vk.gy returns a valid artist page with the artist name in h1
    return html.includes('class="artist') && !html.includes('Page not found');
  } catch { return false; }
}

// ─── Claude helpers ────────────────────────────────────────────────────────────

async function extractBandName(anthropic, title) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 60,
    messages: [{
      role: 'user',
      content: `Extract the primary band or artist name from this Japanese music article title. Reply with just the name in its most recognisable romanised/English form — nothing else. If there are two artists (e.g. a joint interview), give the first one. If you cannot identify a band/artist name, reply: UNKNOWN\n\nTitle: ${title}`,
    }],
  });
  const text = msg.content[0]?.text?.trim() || '';
  return text === 'UNKNOWN' || !text ? null : text;
}

async function confirmVkContext(anthropic, title) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `Is this article about a Visual Kei (ビジュアル系) artist? Visual Kei is a Japanese rock subculture defined by elaborate makeup, costumes, and a rock/metal sound. Answer YES or NO only.\n\nArticle title: ${title}`,
    }],
  });
  const answer = msg.content[0]?.text?.trim().toUpperCase() || '';
  return answer.startsWith('YES');
}

async function translateInterview(anthropic, jaTitle, jaBody, sourceName) {
  const truncated = jaBody.length > MAX_BODY_LEN ? jaBody.slice(0, MAX_BODY_LEN) + '\n\n[Translation truncated — read the full interview at the source link below.]' : jaBody;

  const titleMsg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: `Translate this Japanese music article title to a clean, natural English headline. Rules: remove any Japanese formatting markers like 【インタビュー】 or ◆ or「」brackets from the start — the interview context is already known. Keep band names, album names, and song titles in their original form. Keep "ビジュアル系" as "Visual Kei". Reply with just the translated title.\n\nTitle: ${jaTitle}`,
    }],
  });
  const enTitle = titleMsg.content[0]?.text?.trim() || jaTitle;

  const bodyMsg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Translate this Japanese Visual Kei music interview to natural, readable English.

Rules:
- Keep band names, album names, and song titles exactly as written
- "ビジュアル系" → "Visual Kei" (never translate this differently)
- Preserve Q&A structure — if questions are marked (e.g. ――, 【Q】, or similar), format them as **Q:** in the output
- Sound natural and conversational, not mechanical
- Preserve paragraph breaks, lists, and any subheadings
- Do not add commentary, notes, or translator's notes — just the translation

Interview text:
${truncated}`,
    }],
  });
  const enBody = bodyMsg.content[0]?.text?.trim() || '';
  return { enTitle, enBody };
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url, timeout = 10000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.9',
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function ogImage(html) {
  const m = html.match(/property="og:image"\s+content="([^"]+)"|content="([^"]+)"\s+property="og:image"/);
  const url = m ? (m[1] || m[2]) : null;
  if (!url || url.includes('placeholder') || url.includes('default') || url.includes('logo') || url.includes('noimage')) return null;
  return url;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Source: barks.jp (RSS, VK-guaranteed, filter インタビュー) ─────────────────

async function fetchBarks() {
  console.log(`  [barks.jp] Fetching RSS (${MAX_PAGES} page(s))...`);
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1
      ? 'https://barks.jp/tag/interview/feed/'
      : `https://barks.jp/tag/interview/feed/?paged=${page}`;
    let xml;
    try { xml = await fetchHtml(url); } catch { break; }

    const $ = cheerio.load(xml, { xmlMode: true });
    let newOnPage = 0;

    $('item').each((_, el) => {
      const categories = $(el).find('category').map((_, c) => $(c).text()).get();
      const isVk = categories.some(c => c === 'V-ROCK' || c.includes('ヴィジュアル'));
      if (!isVk) return;

      const itemUrl = $(el).find('link').text().trim() || $(el).find('guid').text().trim();
      if (!itemUrl || seen.has(itemUrl)) return;
      seen.add(itemUrl);

      const title = $(el).find('title').text().trim();
      const date  = $(el).find('pubDate').text().trim();
      const body  = $(el).find('content\\:encoded, encoded').text().trim();
      if (!title) return;

      items.push({ url: itemUrl, title, date: new Date(date).toISOString(), body, source: 'barks.jp', vkGuaranteed: true });
      newOnPage++;
    });

    if (newOnPage === 0) break; // no new items, stop paginating
    await sleep(600);
  }

  console.log(`  [barks.jp] ${items.length} interview items found`);
  return items;
}

// ─── Source: thefirsttimes.jp (RSS, needs VK check) ───────────────────────────

async function fetchFirstTimes() {
  console.log(`  [thefirsttimes.jp] Fetching RSS (${MAX_PAGES} page(s))...`);
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1
      ? 'https://www.thefirsttimes.jp/interview/feed/'
      : `https://www.thefirsttimes.jp/interview/feed/?paged=${page}`;
    let xml;
    try { xml = await fetchHtml(url); } catch { break; }

    const $ = cheerio.load(xml, { xmlMode: true });
    let newOnPage = 0;

    $('item').each((_, el) => {
      const itemUrl = $(el).find('link').text().trim();
      if (!itemUrl || seen.has(itemUrl)) return;
      seen.add(itemUrl);

      const title = $(el).find('title').text().trim();
      const date  = $(el).find('pubDate').text().trim();
      const body  = $(el).find('content\\:encoded, encoded').text().trim();
      if (!title) return;

      items.push({ url: itemUrl, title, date: new Date(date).toISOString(), body, source: 'thefirsttimes.jp', vkGuaranteed: false });
      newOnPage++;
    });

    if (newOnPage === 0) break;
    await sleep(600);
  }

  console.log(`  [thefirsttimes.jp] ${items.length} interview items found`);
  return items;
}

// ─── Source: natalie.mu (HTML scrape listing, needs VK check) ──────────────────

async function fetchNatalie() {
  console.log(`  [natalie.mu] Scraping listing (${MAX_PAGES} page(s))...`);
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const listUrl = page === 1 ? 'https://natalie.mu/music/pp' : `https://natalie.mu/music/pp?page=${page}`;
    let html;
    try { html = await fetchHtml(listUrl); } catch { break; }

    const $ = cheerio.load(html);
    let newOnPage = 0;

    $('a[href*="/music/pp/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.match(/\/music\/pp\/[a-z0-9_-]+$/)) return;
      const url = href.startsWith('http') ? href : `https://natalie.mu${href}`;
      if (seen.has(url)) return;
      seen.add(url);

      const title = $(el).find('h2, h3, .NA_title, [class*="title"]').first().text().trim()
                 || $(el).text().trim();
      if (!title || title.length < 4) return;

      items.push({ url, title, date: new Date().toISOString(), body: '', source: 'natalie.mu', vkGuaranteed: false, needsFetch: true });
      newOnPage++;
    });

    if (newOnPage === 0) break;
    await sleep(600);
  }

  console.log(`  [natalie.mu] ${items.length} interview links found`);
  return items;
}

async function fetchNatalieBody(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || $('title').text().replace(/\s*\|.*$/, '').trim();
  const dateEl = $('[class*="date"], time').first();
  const date = dateEl.attr('datetime') || dateEl.text().trim();
  const body = $('article, .NA_powerpush, [class*="article"]').first().text().trim()
            || $('main p').map((_, p) => $(p).text().trim()).get().join('\n\n');
  const img = ogImage(html);
  return { title: title || '', date: date ? new Date(date).toISOString() : new Date().toISOString(), body, image: img };
}

// ─── Source: spice.eplus.jp (HTML scrape listing, needs VK check) ──────────────

async function fetchSpice() {
  console.log(`  [spice.eplus.jp] Scraping listing (${MAX_PAGES} page(s))...`);
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const listUrl = page === 1
      ? 'https://spice.eplus.jp/articles/interviews'
      : `https://spice.eplus.jp/articles/interviews?p=${page}`;
    let html;
    try { html = await fetchHtml(listUrl); } catch { break; }

    const $ = cheerio.load(html);
    let newOnPage = 0;

    $('a[href*="/articles/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.match(/\/articles\/\d+/)) return;
      const url = href.startsWith('http') ? href : `https://spice.eplus.jp${href}`;
      if (seen.has(url)) return;
      seen.add(url);

      const title = $(el).find('h2, h3, [class*="title"]').first().text().trim()
                 || $(el).attr('title') || '';
      if (!title || title.length < 4) return;

      items.push({ url, title, date: new Date().toISOString(), body: '', source: 'spice.eplus.jp', vkGuaranteed: false, needsFetch: true });
      newOnPage++;
    });

    if (newOnPage === 0) break;
    await sleep(600);
  }

  console.log(`  [spice.eplus.jp] ${items.length} interview links found`);
  return items;
}

async function fetchSpiceBody(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || $('title').text().replace(/\s*\|.*$/, '').trim();
  const dateEl = $('time, [class*="date"]').first();
  const date = dateEl.attr('datetime') || dateEl.text().trim();
  const body = $('.article-detail, .article-body, [class*="article"]').first().text().trim()
            || $('main p').map((_, p) => $(p).text().trim()).get().join('\n\n');
  const img = ogImage(html);
  return { title: title || '', date: date ? new Date(date).toISOString() : new Date().toISOString(), body, image: img };
}

async function fetchBarksBody(url) {
  try {
    const html = await fetchHtml(url);
    const img = ogImage(html);
    return { image: img };
  } catch { return {}; }
}

// ─── Jekyll post writer ────────────────────────────────────────────────────────

function writePost(date, enTitle, enBody, image, bandName, sourceName, sourceUrl) {
  const d = new Date(date);
  const dateStr = d.toISOString().slice(0, 10);
  const slug = slugify(enTitle);
  const filename = `${dateStr}-${slug}.md`;
  const filepath = `${POSTS_DIR}/${filename}`;

  const labels = ['Interviews', 'Translated Interview'];
  if (bandName) labels.push(bandName);
  const labelsYaml = labels.map(l => `"${l.replace(/"/g, '\\"')}"`).join(', ');

  const imageLine = image ? `image: "${image}"\n` : '';
  const credit = `*This interview was originally published in Japanese on [${sourceName}](${sourceUrl}). Translated by VK Chronicle.*\n\n---\n\n`;

  const content = `---
layout: post
title: "${enTitle.replace(/"/g, '\\"')}"
date: ${d.toISOString()}
${imageLine}labels: [${labelsYaml}]
source_url: "${sourceUrl}"
source_name: "${sourceName}"
---

${credit}${enBody}

---

*[Read the original Japanese interview on ${sourceName}](${sourceUrl})*
`;

  writeFileSync(filepath, content, 'utf8');
  return filename;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function commitBatch(filenames) {
  try {
    const files = filenames.map(f => `"_posts/${f}"`).join(' ');
    execSync(`git -C "${SITE_REPO}" add ${files} && git -C "${SITE_REPO}" commit -m "Add ${filenames.length} translated VK interview(s)"`, { stdio: 'pipe' });
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
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tracking  = loadTracking();
  const localBands = loadLocalBandNames();

  console.log(`Loaded ${localBands.size} local bands, ${Object.keys(tracking).length} already-tracked interviews\n`);

  // Fetch from all sources
  let allItems = [];
  try {
    if (!SOURCE_FILTER || SOURCE_FILTER === 'barks')       allItems.push(...await fetchBarks());
  } catch (e) { console.warn(`barks fetch error: ${e.message}`); }
  await sleep(1000);
  try {
    if (!SOURCE_FILTER || SOURCE_FILTER === 'thefirsttimes') allItems.push(...await fetchFirstTimes());
  } catch (e) { console.warn(`thefirsttimes fetch error: ${e.message}`); }
  await sleep(1000);
  try {
    if (!SOURCE_FILTER || SOURCE_FILTER === 'natalie')     allItems.push(...await fetchNatalie());
  } catch (e) { console.warn(`natalie fetch error: ${e.message}`); }
  await sleep(1000);
  try {
    if (!SOURCE_FILTER || SOURCE_FILTER === 'spice')       allItems.push(...await fetchSpice());
  } catch (e) { console.warn(`spice fetch error: ${e.message}`); }

  console.log(`\nTotal candidates: ${allItems.length}`);

  // Filter already-tracked
  const untracked = allItems.filter(i => !tracking[i.url]);
  console.log(`New (untracked): ${untracked.length}\n`);

  let published = 0;
  let batch = [];

  for (const item of untracked) {
    if (published >= MAX) break;
    if (published >= BACKFILL_CAP) break;

    console.log(`\n[${published + 1}] ${item.source} — ${item.title.slice(0, 80)}`);

    // Fetch body if needed (scrape sources)
    if (item.needsFetch) {
      try {
        let fetched;
        if (item.source === 'natalie.mu')    fetched = await fetchNatalieBody(item.url);
        if (item.source === 'spice.eplus.jp') fetched = await fetchSpiceBody(item.url);
        if (fetched) {
          if (fetched.title && fetched.title.length > item.title.length) item.title = fetched.title;
          item.body  = fetched.body || '';
          item.date  = fetched.date || item.date;
          item.image = fetched.image || null;
        }
        await sleep(800);
      } catch (err) {
        console.log(`  → Body fetch failed: ${err.message} — skipping`);
        tracking[item.url] = { skipped: true, reason: 'fetch_failed', date: new Date().toISOString() };
        continue;
      }
    }

    // Fetch image for RSS sources
    if (!item.image && (item.source === 'barks.jp' || item.source === 'thefirsttimes.jp')) {
      try {
        const extra = await fetchBarksBody(item.url);
        item.image = extra.image || null;
        await sleep(500);
      } catch {}
    }

    // Skip short articles
    const bodyText = item.body.replace(/<[^>]+>/g, '').trim();
    if (bodyText.length < MIN_BODY_LEN) {
      console.log(`  → Too short (${bodyText.length} chars) — skipping`);
      tracking[item.url] = { skipped: true, reason: 'too_short', date: new Date().toISOString() };
      continue;
    }

    // VK validation for non-guaranteed sources
    let bandName = null;
    if (!item.vkGuaranteed) {
      bandName = await extractBandName(anthropic, item.title);
      console.log(`  → Band name: ${bandName || 'unknown'}`);
      await sleep(300);

      if (!bandName) {
        console.log(`  → Could not extract band name — skipping`);
        tracking[item.url] = { skipped: true, reason: 'no_band_name', date: new Date().toISOString() };
        continue;
      }

      const isVk = await isVkBand(bandName, localBands);
      if (!isVk) {
        console.log(`  → "${bandName}" not found on vk.gy — not VK, skipping`);
        tracking[item.url] = { skipped: true, reason: 'not_vk', band: bandName, date: new Date().toISOString() };
        continue;
      }
      await sleep(300);
      const isVkContext = await confirmVkContext(anthropic, item.title);
      if (!isVkContext) {
        console.log(`  → "${bandName}" on vk.gy but article context is not VK — skipping`);
        tracking[item.url] = { skipped: true, reason: 'not_vk_context', band: bandName, date: new Date().toISOString() };
        continue;
      }
      console.log(`  ✓ VK confirmed: ${bandName}`);
      await sleep(500);
    } else {
      // For VK-guaranteed sources, still try to extract band name for labelling
      bandName = await extractBandName(anthropic, item.title);
      await sleep(300);
    }

    // Translate
    console.log(`  → Translating...`);
    let enTitle, enBody;
    try {
      ({ enTitle, enBody } = await translateInterview(anthropic, item.title, bodyText, item.source));
      await sleep(500);
    } catch (err) {
      console.log(`  → Translation failed: ${err.message} — skipping`);
      tracking[item.url] = { skipped: true, reason: 'translation_failed', date: new Date().toISOString() };
      continue;
    }

    if (!enBody || enBody.length < 100) {
      console.log(`  → Translation returned empty — skipping`);
      tracking[item.url] = { skipped: true, reason: 'empty_translation', date: new Date().toISOString() };
      continue;
    }

    console.log(`  ✓ Translated: "${enTitle.slice(0, 60)}"`);

    if (DRY) {
      console.log(`  [dry] Would publish: ${enTitle}`);
      continue;
    }

    // Write post
    const filename = writePost(item.date, enTitle, enBody, item.image, bandName, item.source, item.url);
    console.log(`  ✓ Written: ${filename}`);

    tracking[item.url] = { published: true, filename, date: new Date().toISOString() };
    saveTracking(tracking);

    batch.push(filename);
    published++;

    if (batch.length >= COMMIT_EVERY) {
      commitBatch(batch);
      if (!DRY) pushOnce();
      batch = [];
    }

    await sleep(800);
  }

  if (batch.length > 0 && !DRY) commitBatch(batch);
  if (published > 0 && !DRY) pushOnce();

  console.log(`\nDone. ${published} interview(s) published.`);
}

main().catch(err => { console.error(err); process.exit(1); });
