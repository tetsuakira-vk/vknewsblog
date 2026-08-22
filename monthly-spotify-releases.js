/**
 * monthly-spotify-releases.js — Monthly VK New Releases Post
 *
 * Publishes a "New Visual Kei Releases — [Month]" Jekyll post on the 1st of each month.
 * Sources releases from vk.gy (VK-specific database, always complete).
 *
 * Usage:
 *   node monthly-spotify-releases.js             — auto, runs on 1st only
 *   node monthly-spotify-releases.js --force     — run on any day
 *   node monthly-spotify-releases.js --dry-run   — print post, don't publish
 *   node monthly-spotify-releases.js --months=2026-03,2026-04  — combine months
 *
 * Cron (1st of each month, 11am):
 *   0 11 1 * * cd /Users/robertnelson/vknewsblog && /usr/local/bin/node monthly-spotify-releases.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { publishToJekyll, SITE_BASE_URL } from './lib/jekyll.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DRY_RUN   = process.argv.includes('--dry-run');
const FORCE     = process.argv.includes('--force');
const MONTHS_ARG = process.argv.find(a => a.startsWith('--months='))?.split('=')[1] || null;

const VKGY_BASE = 'https://vk.gy';

// ─── Date helpers ─────────────────────────────────────────────────────────────

function monthName(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function monthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ─── Scrape vk.gy releases ────────────────────────────────────────────────────

async function scrapeVkgyReleases(targetMonthKey) {
  const releases = [];
  const seen = new Set();

  const urls = [
    `${VKGY_BASE}/releases/`,
    `${VKGY_BASE}/releases/?month=${targetMonthKey}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { console.warn(`  ! vk.gy returned ${res.status} for ${url}`); continue; }

      const $ = cheerio.load(await res.text());

      $('div.module--release').each((_, el) => {
        const $card = $(el);

        const dateText = $card.find('.release-card__date').first().text().trim();
        if (!dateText || !dateText.startsWith(targetMonthKey)) return;

        const detailHref = $card.find('a.card__link').first().attr('href') || '';
        const detailUrl  = detailHref.startsWith('http') ? detailHref : VKGY_BASE + detailHref;
        if (seen.has(detailUrl)) return;
        seen.add(detailUrl);

        const $artistEl = $card.find('a.release-card__artist');
        const artist = ($artistEl.find('span.any--en').first().text().trim() || $artistEl.text().trim());

        const $titleEl = $card.find('a.release-card__title');
        const title = ($titleEl.find('span.any--en').first().text().trim() || $titleEl.text().trim());

        const imgSrc = $card.find('img.release-card__cover').first().attr('src') || '';
        const image  = imgSrc.startsWith('http') ? imgSrc : imgSrc ? VKGY_BASE + imgSrc : null;

        if (!artist || !title) return;

        const q           = encodeURIComponent(`${artist} ${title}`);
        const cdJapanHref = `https://www.cdjapan.co.jp/searchuni?q=${q}`;
        const amazonHref  = `https://www.amazon.co.jp/s?k=${q}`;

        releases.push({ artist, title, dateText, image, detailUrl, cdJapanHref, amazonHref });
      });

    } catch (err) {
      console.warn(`  ! Error fetching ${url}: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const finalSeen = new Set();
  return releases
    .filter(r => {
      const key = `${r.artist}::${r.title}`;
      if (finalSeen.has(key)) return false;
      finalSeen.add(key);
      return true;
    })
    .sort((a, b) => (a.dateText || '').localeCompare(b.dateText || ''));
}

// ─── Image proxy ──────────────────────────────────────────────────────────────

function proxied(url, w = 200, h = 200) {
  if (!url) return null;
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${w}&h=${h}&fit=cover&output=jpg`;
}

// ─── Generate intro ───────────────────────────────────────────────────────────

async function generateIntro(releases, month) {
  const list = releases.slice(0, 20).map(r => `${r.artist} — ${r.title}`).join(', ');
  const msg  = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    messages: [{
      role: 'user',
      content: `Write a short, enthusiastic 2-sentence intro paragraph for a "Visual Kei New Releases — ${month}" blog post that previews what's dropping this month. Releases include: ${list}. Tone: excited VK fan, editorial voice. Return only the paragraph, no extra text.`,
    }],
  });
  return msg.content[0].text.trim().replace(/^#+\s+[^\n]+\n+/, '');
}

// ─── Format release date ──────────────────────────────────────────────────────

function formatDate(dateText) {
  try {
    return new Date(dateText).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return dateText; }
}

// ─── Build post content ───────────────────────────────────────────────────────

function buildPostContent(releases, intro, month) {
  const now    = new Date().toISOString();
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    'headline': `Visual Kei New Releases — ${month}`,
    'description': `${releases.length} Visual Kei albums, singles, and EPs dropping in ${month}.`,
    'datePublished': now,
    'dateModified':  now,
    'inLanguage': 'en',
    'keywords': 'Visual Kei, new releases, album, single, Japanese rock',
    'author':    { '@type': 'Organization', 'name': 'VK Chronicle', 'url': SITE_BASE_URL },
    'publisher': { '@type': 'Organization', 'name': 'VK Chronicle', 'url': SITE_BASE_URL },
  });

  const cards = releases.map(r => {
    const img     = proxied(r.image);
    const imgHtml = img
      ? `<a href="${r.detailUrl}" target="_blank" rel="noopener" class="nr-thumb-link"><img src="${img}" alt="${r.artist} — ${r.title}" class="nr-thumb" /></a>`
      : `<a href="${r.detailUrl}" target="_blank" rel="noopener" class="nr-thumb-link nr-thumb-placeholder"></a>`;

    const buyLinks = [
      r.cdJapanHref ? `<a href="${r.cdJapanHref}" target="_blank" rel="noopener sponsored" class="nr-buy nr-buy--cdjapan">CDJapan</a>` : '',
      r.amazonHref  ? `<a href="${r.amazonHref}"  target="_blank" rel="noopener sponsored" class="nr-buy nr-buy--amazon">Amazon</a>`  : '',
    ].filter(Boolean).join('');

    return `<div class="nr-card">
  ${imgHtml}
  <div class="nr-info">
    <div class="nr-artist">${r.artist}</div>
    <div class="nr-title"><a href="${r.detailUrl}" target="_blank" rel="noopener">${r.title}</a></div>
    <div class="nr-date">${formatDate(r.dateText)}</div>
    ${buyLinks ? `<div class="nr-links">${buyLinks}</div>` : ''}
  </div>
</div>`;
  }).join('\n');

  return `<script type="application/ld+json">${schema}</script>

<p>${intro}</p>

<!--more-->

<p class="nr-count">${releases.length} release${releases.length !== 1 ? 's' : ''} confirmed for ${month}. Data sourced from <a href="https://vk.gy/releases/" target="_blank" rel="noopener">vk.gy</a>. Dates subject to change.</p>

<div class="nr-grid">
${cards}
</div>

<p style="margin-top:2em;font-size:0.85rem;color:#999;">
  Missed a release? Check <a href="https://vk.gy/releases/" target="_blank" rel="noopener">vk.gy</a> for the complete database, or browse our <a href="/">latest VK news</a>.
</p>

<style>
.nr-count { font-size: 0.82rem; color: rgba(255,255,255,0.4); margin-bottom: 1.5em; }
.nr-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 1.5em 0; }
.nr-card { display: flex; gap: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 12px; }
.nr-thumb-link { flex-shrink: 0; display: block; width: 80px; height: 80px; border-radius: 6px; overflow: hidden; }
.nr-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.nr-thumb-placeholder { background: rgba(255,255,255,0.05); }
.nr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.nr-artist { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: #ecac0d; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nr-title { font-size: 0.88rem; font-weight: 600; line-height: 1.3; }
.nr-title a { color: #fff; text-decoration: none; }
.nr-title a:hover { color: #ecac0d; }
.nr-date { font-size: 0.72rem; color: rgba(255,255,255,0.35); }
.nr-links { display: flex; gap: 6px; margin-top: 4px; }
.nr-buy { font-size: 0.68rem; padding: 3px 9px; border-radius: 20px; text-decoration: none; font-weight: 600; letter-spacing: 0.03em; }
.nr-buy--cdjapan { background: rgba(236,172,13,0.1); border: 1px solid rgba(236,172,13,0.3); color: #ecac0d; }
.nr-buy--amazon { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.6); }
@media (max-width: 600px) { .nr-grid { grid-template-columns: 1fr; } }
</style>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date();
  if (today.getDate() !== 1 && !FORCE) {
    console.log(`  → Skipping: today is the ${today.getDate()}, not the 1st. Use --force to override.`);
    return;
  }

  let targetKeys, label;
  if (MONTHS_ARG) {
    targetKeys = MONTHS_ARG.split(',').map(s => s.trim()).filter(Boolean);
    label = targetKeys.map(k => {
      const [y, m] = k.split('-');
      return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }).join(' & ');
  } else {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    targetKeys       = [monthKey(monthStart)];
    label            = monthName(monthStart);
  }
  console.log(`Building releases post for ${label} (${targetKeys.join(', ')})...`);

  console.log('  → Scraping vk.gy...');
  const allReleases = [];
  for (const key of targetKeys) {
    const found = await scrapeVkgyReleases(key);
    console.log(`  → ${found.length} releases found for ${key}`);
    allReleases.push(...found);
  }

  const seenIds  = new Set();
  const releases = allReleases.filter(r => {
    const k = `${r.artist}::${r.title}`;
    if (seenIds.has(k)) return false;
    seenIds.add(k);
    return true;
  }).sort((a, b) => (a.dateText || '').localeCompare(b.dateText || ''));

  console.log(`  → ${releases.length} unique releases total`);

  if (releases.length === 0) {
    console.log('  → No releases found. Skipping.');
    return;
  }

  const intro   = await generateIntro(releases, label);
  const title   = `Visual Kei New Releases — ${label}`;
  const content = buildPostContent(releases, intro, label);

  if (DRY_RUN) {
    console.log(`\nTITLE: ${title}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(content.slice(0, 1500), '\n...[truncated]');
    console.log(`\nReleases (${releases.length}):`);
    for (const r of releases) console.log(`  ${r.dateText}  ${r.artist} — ${r.title}`);
    return;
  }

  const postUrl = publishToJekyll(
    title,
    ['Visual Kei', 'New Releases', 'Monthly Roundup'],
    content,
  );
  console.log(`  ✓ Published: ${postUrl}`);
}

main().catch(err => { console.error(err); process.exit(1); });
