/**
 * update-releases-page.js - Scrape VK releases and update the Jekyll releases page
 *
 * Primary source: vk.gy (has artwork for every release, VK-specific)
 * Ranked section:  CDJapan (filtered to recent/upcoming only)
 *
 * Usage: node update-releases-page.js
 * Cron (weekly, Sunday 9am): 0 9 * * 0 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node update-releases-page.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { readFileSync } from 'fs';
import path from 'path';
import { updateJekyllPage, SITE_REPO_PATH } from './lib/jekyll.js';

const CDJAPAN_BASE = 'https://www.cdjapan.co.jp';
const VKGY_BASE    = 'https://vk.gy';
const WEEKS_BACK   = 4;
const WEEKS_FORWARD = 8;

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseReleaseDate(dateText) {
  if (!dateText) return null;
  const d = new Date(dateText);
  return isNaN(d.getTime()) ? null : d;
}

function inRollingWindow(dateText) {
  const d = parseReleaseDate(dateText);
  if (!d) return false; // exclude undated items from ranked section
  const now         = Date.now();
  const windowStart = now - WEEKS_BACK    * 7 * 86400000;
  const windowEnd   = now + WEEKS_FORWARD * 7 * 86400000;
  return d.getTime() >= windowStart && d.getTime() <= windowEnd;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatDisplayDate(dateText) {
  try {
    return new Date(dateText).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return dateText; }
}

// ─── vk.gy scraper (primary source) ──────────────────────────────────────────

async function scrapeVkgy() {
  const now      = new Date();
  const past     = new Date(now.getTime() - WEEKS_BACK    * 7 * 86400000);
  const future   = new Date(now.getTime() + WEEKS_FORWARD * 7 * 86400000);
  const pastStr  = past.toISOString().slice(0, 10);
  const futureStr = future.toISOString().slice(0, 10);

  // Collect unique months to query
  const monthsSet = new Set();
  const cursor = new Date(past);
  while (cursor <= future) {
    monthsSet.add(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const releases = [];
  const seen     = new Set();

  for (const month of monthsSet) {
    const url = `${VKGY_BASE}/releases/?month=${month}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { console.warn(`  ! vk.gy ${res.status} for ${url}`); continue; }

      const $ = cheerio.load(await res.text());

      $('div.module--release').each((_, el) => {
        const $card    = $(el);
        const dateText = $card.find('.release-card__date').first().text().trim();
        if (!dateText || dateText < pastStr || dateText > futureStr) return;

        const detailHref = $card.find('a.card__link').first().attr('href') || '';
        const detailUrl  = detailHref.startsWith('http') ? detailHref : VKGY_BASE + detailHref;
        if (seen.has(detailUrl)) return;
        seen.add(detailUrl);

        const $artistEl = $card.find('a.release-card__artist');
        const artist    = $artistEl.find('span.any--en').first().text().trim() || $artistEl.text().trim();

        const $titleEl  = $card.find('a.release-card__title');
        const title     = $titleEl.find('span.any--en').first().text().trim() || $titleEl.text().trim();

        const imgSrc = $card.find('img.release-card__cover').first().attr('src') || '';
        const image  = imgSrc.startsWith('http') ? imgSrc : imgSrc ? VKGY_BASE + imgSrc : null;

        if (!artist || !title) return;
        releases.push({ artist, title, dateText, image, url: detailUrl });
      });

    } catch (err) {
      console.warn(`  ! Error fetching ${url}: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Deduplicate by artist::title and sort by date
  const finalSeen = new Set();
  return releases
    .filter(r => {
      const key = `${r.artist}::${r.title}`;
      if (finalSeen.has(key)) return false;
      finalSeen.add(key);
      return true;
    })
    .sort((a, b) => a.dateText.localeCompare(b.dateText));
}

// ─── CDJapan scraper (ranked section only) ────────────────────────────────────

async function scrapeReleasesSafe(url) {
  try { return await scrapeReleases(url); } catch (err) {
    console.warn(`  ! Skipped ${url}: ${err.message}`);
    return [];
  }
}

async function scrapeReleases(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`CDJapan returned ${res.status}`);
  const $ = cheerio.load(await res.text());
  const releases = [];

  $('li').has('a.item-wrap').each((_, el) => {
    const $wrap    = $(el).find('a.item-wrap').first();
    const href     = $wrap.attr('href');
    const link     = href ? (href.startsWith('http') ? href : CDJAPAN_BASE + href) : null;
    const title    = $wrap.find('.title-text, [itemprop="name"]').first().text().trim();
    const artist   = $wrap.find('i.artist').first().text().trim();
    const format   = $wrap.find('.label.media, .label.blue').first().text().trim();
    const price    = $wrap.find('.price-jp-yen').first().text().trim();
    const dateText = $wrap.find('li.release span').first().text().trim();
    const rawImg   = $wrap.find('img').first().attr('src');
    const imgSrc   = rawImg ? (rawImg.startsWith('//') ? 'https:' + rawImg : rawImg) : null;
    const imgUrl   = imgSrc ? imgSrc.replace('/pictures/s/', '/pictures/l/') : null;
    if (title && link) releases.push({ title, artist, link, imgUrl, dateText, format, price });
  });

  return releases;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buyLinks(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return [
    `<a class="release-buy" href="https://www.cdjapan.co.jp/searchuni?term.mo=${q}&type=title" target="_blank" rel="noopener">CDJapan</a>`,
    `<a class="release-buy" href="https://www.yesasia.com/global/search/?query=${q}&search_url=1&section=music" target="_blank" rel="noopener">YesAsia</a>`,
    `<a class="release-buy" href="https://www.amazon.co.jp/s?k=${q}&i=music-jp" target="_blank" rel="noopener">Amazon JP</a>`,
  ].join(' ');
}

function vkgyCard(r, rank) {
  const imgSrc  = r.image ? `https://images.weserv.nl/?url=${encodeURIComponent(r.image)}&w=200&output=jpg` : null;
  const coverHtml = imgSrc
    ? `<img class="release-cover" src="${imgSrc}" alt="${r.title.replace(/"/g, '&quot;')}" loading="lazy" />`
    : `<div class="release-cover release-cover-placeholder">💿</div>`;
  const displayDate = formatDisplayDate(r.dateText);
  const rankBadge = rank ? `<span class="rank-badge">#${rank}</span>` : '';
  return `<article class="release-card">
  ${coverHtml}
  <div class="release-info">
    ${rankBadge}<div class="release-artist">${r.artist}</div>
    <h3 class="release-title"><a href="${r.url}" target="_blank" rel="noopener">${r.title}</a></h3>
    <div class="release-meta">${displayDate}</div>
    <div class="release-buy-row">${buyLinks(r.artist, r.title)}</div>
  </div>
</article>`;
}

function cdjCard(r, rank) {
  const coverHtml = r.imgUrl
    ? `<img class="release-cover" src="https://images.weserv.nl/?url=${encodeURIComponent(r.imgUrl)}&w=200&output=jpg" alt="${r.title.replace(/"/g, '&quot;')}" loading="lazy" />`
    : `<div class="release-cover release-cover-placeholder">💿</div>`;
  const metaParts = [r.format, r.dateText, r.price].filter(Boolean);
  const rankBadge = rank ? `<span class="rank-badge">#${rank}</span>` : '';
  return `<article class="release-card">
  ${coverHtml}
  <div class="release-info">
    ${rankBadge}${r.artist ? `<div class="release-artist">${r.artist}</div>` : ''}
    <h3 class="release-title"><a href="${r.link}" target="_blank" rel="noopener">${r.title}</a></h3>
    ${metaParts.length ? `<div class="release-meta">${metaParts.join(' · ')}</div>` : ''}
    <div class="release-buy-row">
      <a class="release-buy" href="${r.link}" target="_blank" rel="noopener">CDJapan</a>
      ${(q => `<a class="release-buy" href="https://www.yesasia.com/global/search/?query=${q}&search_url=1&section=music" target="_blank" rel="noopener">YesAsia</a> <a class="release-buy" href="https://www.amazon.co.jp/s?k=${q}&i=music-jp" target="_blank" rel="noopener">Amazon JP</a>`)(encodeURIComponent(`${r.artist} ${r.title}`))}
    </div>
  </div>
</article>`;
}

function groupByMonth(releases) {
  const groups = {};
  for (const r of releases) {
    const d = parseReleaseDate(r.dateText);
    const key = d
      ? d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
      : 'Date TBA';
    if (!groups[key]) groups[key] = { sortKey: r.dateText.slice(0, 7), items: [] };
    groups[key].items.push(r);
  }
  return Object.entries(groups)
    .sort(([, a], [, b]) => a.sortKey.localeCompare(b.sortKey))
    .map(([label, { items }]) => ({ label, items }));
}

function readThisWeek() {
  try {
    return JSON.parse(readFileSync(path.join(SITE_REPO_PATH, '_data/this_week.json'), 'utf8'));
  } catch { return []; }
}

function thisWeekSection(releases) {
  if (!releases.length) return '<p style="color:#666;padding:40px 0;text-align:center;">No releases found this week — check back Sunday.</p>';

  const cards = releases.map(r => {
    const cover = r.image
      ? `<img class="week-cover" src="https://images.weserv.nl/?url=${encodeURIComponent(r.image)}&w=200&output=jpg" alt="${r.title.replace(/"/g, '&quot;')}" loading="lazy">`
      : `<div class="week-cover week-cover--placeholder">💿</div>`;
    const embed = r.youtube_id
      ? `<div class="week-embed"><iframe src="https://www.youtube.com/embed/${r.youtube_id}" loading="lazy" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe></div>`
      : `<div class="week-no-video">No official video found</div>`;
    const d = new Date(r.date);
    const dateStr = isNaN(d) ? r.date : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    return `<article class="week-card">
  <div class="week-card-top">
    ${cover}
    <div class="week-info">
      <div class="week-artist">${r.artist}</div>
      <h3 class="week-title"><a href="${r.vkgy_url}" target="_blank" rel="noopener">${r.title}</a></h3>
      <div class="week-meta">${dateStr}</div>
    </div>
  </div>
  ${embed}
  <div class="week-links">
    <a class="release-buy" href="${r.cdjapan}" target="_blank" rel="noopener">CDJapan</a>
    <a class="release-buy" href="${r.amazon}" target="_blank" rel="noopener">Amazon JP</a>
    <a class="release-buy" href="${r.yesasia}" target="_blank" rel="noopener">YesAsia</a>
    <a class="release-buy" href="${r.vkgy_url}" target="_blank" rel="noopener">vk.gy</a>
  </div>
</article>`;
  }).join('\n');

  return `<div class="week-grid">${cards}</div>`;
}

function buildPageContent(topRanked, vkgyReleases, scrapedAt) {
  const topSection = topRanked.length ? `
<div class="releases-month-section">
  <div class="releases-date-heading">Trending on CDJapan</div>
  <div class="releases-grid">
    ${topRanked.map((r, i) => cdjCard(r, i + 1)).join('\n')}
  </div>
</div>` : '';

  const monthGroups = groupByMonth(vkgyReleases);
  const dateBlocks = monthGroups.map(({ label, items }) => `
<div class="releases-month-section">
  <div class="releases-date-heading">${label}</div>
  <div class="releases-grid">
    ${items.map(r => vkgyCard(r, null)).join('\n')}
  </div>
</div>`).join('\n');

  const thisWeek = readThisWeek();

  return `<style>
  .releases-date-heading { font-size: 1rem; font-weight: 700; color: #bbb; text-transform: uppercase;
    letter-spacing: .05em; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 8px; margin: 0 0 14px; }
  .releases-grid { display: grid; gap: 14px; grid-template-columns: repeat(12, 1fr); margin-bottom: 32px; }
  .release-card { grid-column: span 12; display: flex; gap: 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; background: rgba(255,255,255,0.02); padding: 10px; }
  @media (min-width: 540px) { .release-card { grid-column: span 6; } }
  @media (min-width: 900px) { .release-card { grid-column: span 4; } }
  .release-cover { flex-shrink: 0; width: 90px; height: 90px; object-fit: cover; border-radius: 8px; background: #222; }
  .release-cover-placeholder { display:flex;align-items:center;justify-content:center;font-size:1.8rem; }
  .release-info { flex: 1; min-width: 0; }
  .release-artist { font-size: 0.78rem; color: #bbb; margin: 0 0 3px; text-transform: uppercase; letter-spacing: .04em; }
  .release-title { margin: 0 0 4px; font-size: 0.95rem; line-height: 1.2; }
  .release-title a { text-decoration: none; color: #fff; }
  .release-meta { font-size: 0.78rem; color: #999; margin: 0 0 8px; }
  .release-buy-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .release-buy { display: inline-block; padding: 4px 9px; border-radius: 8px; font-size: 0.75rem; border: 1px solid rgba(255,255,255,0.15); text-decoration: none; color: #ccc; white-space: nowrap; }
  .release-buy:hover { background: rgba(255,255,255,0.08); color: #fff; }
  .rank-badge { display: inline-block; background: #ecac0d; color: #000; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 6px; margin-bottom: 4px; }
  .release-tabs { display: flex; gap: 8px; margin-bottom: 28px; }
  .release-tab { background: none; border: 1px solid rgba(255,255,255,0.15); color: #aaa; padding: 7px 18px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; transition: all .15s; }
  .release-tab:hover { color: #fff; border-color: rgba(255,255,255,0.35); }
  .release-tab.active { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.4); color: #fff; font-weight: 600; }
  .week-grid { display: grid; gap: 20px; grid-template-columns: 1fr; margin-bottom: 32px; }
  @media (min-width: 600px) { .week-grid { grid-template-columns: 1fr 1fr; } }
  @media (min-width: 960px) { .week-grid { grid-template-columns: 1fr 1fr 1fr; } }
  .week-card { border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; background: rgba(255,255,255,0.02); overflow: hidden; display: flex; flex-direction: column; }
  .week-card-top { display: flex; gap: 12px; padding: 14px; }
  .week-cover { width: 80px; height: 80px; object-fit: cover; border-radius: 8px; flex-shrink: 0; }
  .week-cover--placeholder { width: 80px; height: 80px; background: #222; border-radius: 8px; display:flex; align-items:center; justify-content:center; font-size:1.6rem; flex-shrink: 0; }
  .week-info { flex: 1; min-width: 0; }
  .week-artist { font-size: 0.72rem; color: #bbb; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
  .week-title { font-size: 0.95rem; font-weight: 600; line-height: 1.25; margin-bottom: 4px; }
  .week-title a { color: #fff; text-decoration: none; }
  .week-meta { font-size: 0.75rem; color: #888; }
  .week-embed { width: 100%; aspect-ratio: 16/9; background: #0a0a0a; flex-shrink: 0; }
  .week-embed iframe { width: 100%; height: 100%; border: 0; display: block; }
  .week-no-video { padding: 18px; text-align: center; color: #444; font-size: 0.8rem; }
  .week-links { padding: 10px 14px; display: flex; flex-wrap: wrap; gap: 5px; margin-top: auto; }
</style>

<div class="container" style="padding:40px 0;">

<div class="release-tabs">
  <button class="release-tab active" data-tab="calendar">Release Calendar</button>
  <button class="release-tab" data-tab="this-week">This Week${thisWeek.length ? ` <span style="font-size:0.75rem;opacity:0.7">(${thisWeek.length})</span>` : ''}</button>
</div>

<div id="reltab-calendar">
<p style="color:#bbb;font-size:0.9rem;margin-bottom:28px;">Visual Kei releases — ${WEEKS_BACK} weeks back through ${WEEKS_FORWARD} weeks ahead. Data from vk.gy.</p>
${topSection}
${dateBlocks}
<p style="font-size:0.8rem;color:#666;margin-top:24px;">Release data from <a href="https://vk.gy/releases/" target="_blank" rel="noopener">vk.gy</a>. Trending from <a href="https://www.cdjapan.co.jp/music/j-pop/visualkei/" target="_blank" rel="noopener">CDJapan</a>. Updated ${scrapedAt}.</p>
</div>

<div id="reltab-this-week" style="display:none">
<p style="color:#bbb;font-size:0.9rem;margin-bottom:28px;">VK releases from the past 7 days — with official MVs where available.</p>
${thisWeekSection(thisWeek)}
</div>

<script>
document.querySelectorAll('.release-tab').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.release-tab').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    ['calendar','this-week'].forEach(function(id) {
      document.getElementById('reltab-' + id).style.display = btn.dataset.tab === id ? '' : 'none';
    });
  });
});
</script>

</div>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Scraping vk.gy for releases...');
  const vkgyReleases = await scrapeVkgy();
  console.log(`  → ${vkgyReleases.length} releases from vk.gy`);

  console.log('Scraping CDJapan for trending...');
  const ranked = await scrapeReleasesSafe(`${CDJAPAN_BASE}/music/j-pop/visualkei/?s=rank`);

  // Only include ranked items with recent/upcoming dates
  const topRanked = ranked
    .filter(r => r.title && inRollingWindow(r.dateText))
    .slice(0, 5);
  console.log(`  → ${topRanked.length} trending releases (filtered to window)`);

  if (vkgyReleases.length === 0) {
    console.log('No releases found from vk.gy — check selectors.');
    return;
  }

  const scrapedAt = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const content   = buildPageContent(topRanked, vkgyReleases, scrapedAt);

  updateJekyllPage(
    'releases/index.html',
    { layout: 'default', title: 'New Visual Kei Releases', permalink: '/releases/' },
    content,
    'Update releases page',
  );
  console.log('✓ Done.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
