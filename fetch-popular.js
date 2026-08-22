/**
 * fetch-popular.js
 * Queries GA4 for top posts by pageviews (last 90 days), matches each URL to
 * its Jekyll post file, and writes _data/popular_posts.yml.
 * Run automatically from the pipeline, or manually: node fetch-popular.js
 */

import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { pushWithRebase } from './lib/jekyll.js';

const SITE_REPO_PATH = process.env.SITE_REPO_PATH || '/Users/robertnelson/vkchronicle';
const POSTS_DIR = `${SITE_REPO_PATH}/_posts`;
const OUT_FILE = `${SITE_REPO_PATH}/_data/popular_posts.yml`;
const TOP_N = 20;

// ─── Auth ────────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const { token } = await auth.getAccessToken();
  return token;
}

// ─── GA4 Data API ────────────────────────────────────────────────────────────

async function fetchTopPosts(accessToken) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 100,
        dimensionFilter: {
          filter: {
            fieldName: 'pagePath',
            stringFilter: {
              matchType: 'FULL_REGEXP',
              value: '^/20[0-9]{2}/[0-9]{2}/.+/$',
            },
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GA4 API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.rows || []).map(row => ({
    path: row.dimensionValues[0].value,
    views: parseInt(row.metricValues[0].value, 10),
  }));
}

// ─── Post matching ───────────────────────────────────────────────────────────

function buildPostIndex() {
  const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const index = new Map(); // slug → { filename, raw }

  for (const filename of files) {
    // filename: YYYY-MM-DD-slug.md → slug is everything after the third dash group
    const m = filename.match(/^\d{4}-\d{2}-\d{2}-(.+)\.md$/);
    if (!m) continue;
    const slug = m[1];
    const raw = readFileSync(`${POSTS_DIR}/${filename}`, 'utf8');
    index.set(slug, { filename, raw });
  }
  return index;
}

function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1];
  const result = {};

  // title — handle escaped quotes inside double-quoted YAML strings
  const title = block.match(/^title:\s+"((?:[^"\\]|\\.)*)"/m) || block.match(/^title:\s+'([^']*)'/m) || block.match(/^title:\s+(.+)$/m);
  if (title) result.title = title[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();

  // image
  const image = block.match(/^image:\s+"([^"]*)"/m) || block.match(/^image:\s+'([^']*)'/m) || block.match(/^image:\s+(\S+)/m);
  if (image) result.image = image[1].trim();

  // date
  const date = block.match(/^date:\s+(.+)$/m);
  if (date) result.date = new Date(date[1].trim());

  // labels
  const labels = block.match(/^labels:\s+\[([^\]]*)\]/m);
  if (labels) {
    result.labels = labels[1]
      .split(',')
      .map(l => l.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
      .slice(0, 2);
  }

  return result;
}

function extractExcerpt(raw) {
  // Strip front matter, then take the first non-empty paragraph of text
  const body = raw.replace(/^---[\s\S]*?---\r?\n/, '');
  const text = body
    .replace(/\{%[^%]*%\}/g, '')     // liquid tags
    .replace(/<[^>]+>/g, ' ')        // html tags
    .replace(/!\[.*?\]\(.*?\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text
    .replace(/#{1,6}\s+/g, '')       // headings
    .replace(/\*\*|__|\*|_/g, '')    // bold/italic
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 120).replace(/\s\S*$/, '…');
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function yamlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function fetchAndSavePopular() {
  console.log('fetch-popular.js starting...');
  if (!process.env.GA4_PROPERTY_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.log('  → GA4_PROPERTY_ID or GOOGLE_REFRESH_TOKEN missing, skipping');
    return;
  }

  console.log('Fetching popular posts from GA4...');
  let rows;
  try {
    const token = await getAccessToken();
    rows = await fetchTopPosts(token);
  } catch (err) {
    console.warn(`  → GA4 fetch failed: ${err.message}`);
    return;
  }
  console.log(`  → ${rows.length} paths returned from GA4`);

  const postIndex = buildPostIndex();
  const results = [];

  for (const { path, views } of rows) {
    if (results.length >= TOP_N) break;

    // path: /2026/05/some-slug/  →  extract year, month, slug
    const pm = path.match(/^\/(\d{4})\/(\d{2})\/([^/]+)\//);
    if (!pm) continue;
    const [, year, month, slug] = pm;

    // Find matching post file — slug must match exactly
    const post = postIndex.get(slug);
    if (!post) continue;

    const fm = parseFrontMatter(post.raw);
    if (!fm.title) continue;

    results.push({
      url: path,
      title: fm.title,
      image: fm.image || '/assets/images/placeholder.jpg',
      date_formatted: fm.date ? formatDate(fm.date) : `${month}/${year}`,
      date_iso: fm.date ? fm.date.toISOString().slice(0, 10) : `${year}-${month}-01`,
      excerpt: extractExcerpt(post.raw),
      labels: fm.labels || [],
      views,
    });
  }

  console.log(`  → ${results.length} posts matched to files`);

  // Write YAML
  const lines = [
    `updated: ${yamlStr(new Date().toISOString())}`,
    `posts:`,
  ];
  for (const p of results) {
    lines.push(`  - url: ${yamlStr(p.url)}`);
    lines.push(`    title: ${yamlStr(p.title)}`);
    lines.push(`    image: ${yamlStr(p.image)}`);
    lines.push(`    date_formatted: ${yamlStr(p.date_formatted)}`);
    lines.push(`    date_iso: ${yamlStr(p.date_iso)}`);
    lines.push(`    excerpt: ${yamlStr(p.excerpt)}`);
    lines.push(`    labels:`);
    for (const l of p.labels) lines.push(`      - ${yamlStr(l)}`);
  }

  writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`  → Written to _data/popular_posts.yml`);

  try {
    execSync(`git -C "${SITE_REPO_PATH}" add "_data/popular_posts.yml"`, { stdio: 'pipe' });
    execSync(
      `git -C "${SITE_REPO_PATH}" diff --cached --quiet || git -C "${SITE_REPO_PATH}" commit -m "Update popular posts ranking"`,
      { stdio: 'pipe' }
    );
    pushWithRebase();
    console.log(`  → popular_posts.yml committed`);
  } catch (err) {
    console.warn(`  → popular_posts.yml update failed: ${err.stderr?.toString().slice(0, 120) || err.message}`);
  }
}

// ─── Birthday widget data ─────────────────────────────────────────────────────

async function fetchAndSaveBirthdays() {
  const OUT = `${SITE_REPO_PATH}/_data/birthdays.yml`;
  try {
    const res = await fetch('http://www.vkdb.jp/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const html = new TextDecoder('euc-jp').decode(buf);
    const $ = cheerio.load(html);

    const members = [];
    $('h4').each((_, h4el) => {
      const memberLink = $(h4el).find('a').first();
      if (!memberLink.length) return;

      // Member name is text before the first '(' e.g. "Seika(セイカ)" → "Seika"
      const memberName = memberLink.text().trim().split('(')[0].trim();
      if (!memberName) return;

      // Band history is in the following <p> as links separated by →
      // Last link = most recent band
      const p = $(h4el).next('p');
      if (!p.length) return;
      const bandLinks = p.find('a');
      if (!bandLinks.length) return;

      const bandName = bandLinks.last().text().trim();
      // Skip Japanese-only band names and placeholder statuses
      if (!bandName || !/^[\x20-\x7E]+$/.test(bandName)) return;
      if (bandName.includes('個人') || bandName.includes('不明')) return;

      members.push({ name: memberName, band: bandName });
    });

    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const lines = [
      `date: "${today}"`,
      `members:`,
      ...members.map(m => `  - name: "${m.name.replace(/"/g, '\\"')}"\n    band: "${m.band.replace(/"/g, '\\"')}"`),
    ];
    writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
    console.log(`  → ${members.length} birthdays written for ${today}`);

    execSync(`git -C "${SITE_REPO_PATH}" add "_data/birthdays.yml"`, { stdio: 'pipe' });
    execSync(
      `git -C "${SITE_REPO_PATH}" diff --cached --quiet || git -C "${SITE_REPO_PATH}" commit -m "Update birthday widget: ${today}"`,
      { stdio: 'pipe' }
    );
    pushWithRebase();
  } catch (err) {
    console.warn(`  → Birthday fetch failed: ${err.stderr?.toString().slice(0, 120) || err.message}`);
  }
}

export async function fetchAndSavePopularAndBirthdays() {
  await fetchAndSavePopular();
  await fetchAndSaveBirthdays();
}

// Run when executed directly: node fetch-popular.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchAndSavePopularAndBirthdays().catch(console.error);
}
