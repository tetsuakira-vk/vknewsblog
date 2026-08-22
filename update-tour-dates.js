/**
 * update-tour-dates.js - Scrape worldwide VK tour dates and update the Jekyll tour-dates page
 *
 * Sources: jame-world.com/en/event (worldwide VK/J-rock events with Western shows)
 *
 * Usage: node update-tour-dates.js
 * Cron (weekly, Sunday 10am): 0 10 * * 0 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node update-tour-dates.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';
import { updateJekyllPage } from './lib/jekyll.js';

const JAME_BASE      = 'https://www.jame-world.com';
const JAME_EVENTS    = `${JAME_BASE}/en/event`;
const LIVEFANS_BASE  = 'https://www.livefans.jp';
const LIVEFANS_IDS   = 'livefans-ids.json';
const WEEKS_FORWARD  = 20;

// ─── Scraper ──────────────────────────────────────────────────────────────────

async function scrapeJameEvents() {
  const res = await fetch(`${JAME_BASE}/en/`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`JaME returned ${res.status}`);
  const $ = cheerio.load(await res.text());
  const events    = [];
  const windowEnd = new Date(Date.now() + WEEKS_FORWARD * 7 * 86400000);
  const yesterday = new Date(Date.now() - 86400000);

  $('a[href*="/en/event/"]').each((_, el) => {
    const $a  = $(el);
    const href = $a.attr('href') || '';
    if (!/\/en\/event\/\d{4,}/.test(href)) return;

    const link  = href.startsWith('http') ? href : JAME_BASE + href;
    const title = $a.text().trim();
    if (!title) return;

    const $row   = $a.closest('tr');
    if (!$row.length) return;
    const $cells = $row.find('td');
    if ($cells.length < 3) return;

    const dateRaw  = $cells.eq(0).text().trim();
    const isoMatch = dateRaw.match(/(\d{4}-\d{2}-\d{2})/);
    const dateText = isoMatch ? isoMatch[1] : '';

    if (dateText) {
      const d = new Date(dateText);
      if (d < yesterday || d > windowEnd) return;
    }

    const td1Lines  = $cells.eq(1).text().split('\n').map(s => s.trim()).filter(Boolean);
    const eventType = td1Lines[0] || '';
    const artist    = td1Lines.find(l => l !== eventType && l !== title) || '';

    const td2Lines = $cells.eq(2).text().split('\n').map(s => s.trim()).filter(Boolean);
    const venue    = td2Lines[0] || '';
    const location = td2Lines[1] || '';
    const country  = td2Lines[td2Lines.length - 1] || '';

    events.push({ title, link, dateText, artist, venue, location, country, eventType });
  });

  const seen = new Set();
  return events.filter(e => { if (seen.has(e.link)) return false; seen.add(e.link); return true; });
}

// ─── livefans.jp upcoming events ──────────────────────────────────────────────

async function scrapeLivefansUpcoming() {
  if (!existsSync(LIVEFANS_IDS)) return [];
  const idMap = JSON.parse(readFileSync(LIVEFANS_IDS, 'utf8'));
  const bands = Object.entries(idMap).filter(([, id]) => id);

  const events = [];
  const seen   = new Set();
  const today  = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + WEEKS_FORWARD * 7 * 86400000).toISOString().slice(0, 10);

  for (const [bandKey, artistId] of bands) {
    try {
      const res = await fetch(`${LIVEFANS_BASE}/artists/future/${artistId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept-Language': 'ja,en;q=0.9',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) { console.warn(`  ! livefans ${bandKey}: ${res.status}`); continue; }

      const $ = cheerio.load(await res.text());

      $('.whiteBack.midBox').each((_, el) => {
        const href    = $(el).find('a[href^="/events/"]').first().attr('href') || '';
        const eventId = href.match(/\/events\/(\d+)/)?.[1];
        if (!eventId || seen.has(eventId)) return;
        seen.add(eventId);

        const dateRaw = $(el).find('p.date').first().text().trim();
        const dm      = dateRaw.match(/(\d{4})\/(\d{2})\/(\d{2})/);
        const showDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
        if (!showDate || showDate < today || showDate > cutoff) return;

        const title    = $(el).find('h3.artistName a').first().text().trim();
        const addrRaw  = $(el).find('address').first().text().trim().replace(/^[＠@]/, '');
        const addrParts = addrRaw.match(/^(.+?)\s*[（(]([^)）]+)[)）]$/);
        const venue    = addrParts ? addrParts[1].trim() : addrRaw;
        const location = addrParts ? addrParts[2].trim() : '';

        // Artist display: use guestArtist text from page (may be JP or EN)
        const guestRaw = $(el).find('p.guestArtist').text().replace(/\[出演\]/, '').trim();
        const artist   = guestRaw || bandKey;

        events.push({
          title:     title || artist,
          link:      `${LIVEFANS_BASE}/events/${eventId}`,
          dateText:  showDate,
          artist,
          venue,
          location,
          country:   'Japan',
          eventType: 'Live',
          searchExtra: bandKey, // ensure English band name is searchable
        });
      });

      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.warn(`  ! livefans ${bandKey}: ${err.message}`);
    }
  }

  console.log(`  → ${events.length} upcoming Japan shows from livefans.jp`);
  return events;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function getMonthKey(dateText) {
  if (!dateText) return '';
  try {
    const d = new Date(dateText);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch { return ''; }
}

function getMonthLabel(monthKey) {
  if (!monthKey) return '';
  const [year, month] = monthKey.split('-');
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

function formatEventDate(dateText) {
  if (!dateText) return 'TBA';
  try {
    return new Date(dateText).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return dateText; }
}

function buildTourContent(events, scrapedAt) {
  if (events.length === 0) {
    return `<div style="color:#999;font-style:italic;padding:20px 0;">No upcoming shows found. Check back soon.</div>
<p style="font-size:0.8rem;color:#555;margin-top:16px;">Data sourced from <a href="${JAME_EVENTS}" target="_blank" rel="noopener">JaME World</a>. Updated ${scrapedAt}.</p>`;
  }

  const countries = [...new Set(events.map(e => e.country).filter(Boolean))].sort((a, b) => {
    if (a === 'Japan') return -1; if (b === 'Japan') return 1; return a.localeCompare(b);
  });
  const months = [...new Set(events.map(e => getMonthKey(e.dateText)).filter(Boolean))].sort();

  const eventRows = events
    .sort((a, b) => (a.dateText || '').localeCompare(b.dateText || ''))
    .map(e => {
      const monthKey  = getMonthKey(e.dateText);
      const country   = (e.country || 'Other').replace(/"/g, '&quot;');
      const searchText = [e.title, e.artist, e.venue, e.location, e.country, e.searchExtra || ''].join(' ').toLowerCase();
      return `<div class="td-event" data-country="${country}" data-month="${monthKey}" data-search="${searchText.replace(/"/g, '&quot;')}">
  <div class="td-date">${formatEventDate(e.dateText)}</div>
  <div class="td-info">
    <div class="td-title"><a href="${e.link}" target="_blank" rel="noopener">${e.title}</a></div>
    <div class="td-meta">
      ${e.artist ? `<span class="td-artist">${e.artist}</span>` : ''}
      ${e.country && e.country !== 'Japan' ? `<span class="td-badge td-badge--intl">${e.country}</span>` : ''}
      ${e.venue ? `<span class="td-venue">${[e.venue, e.location].filter(Boolean).join(', ')}</span>` : ''}
    </div>
  </div>
</div>`;
    }).join('\n');

  const countryBtns = ['All', ...countries].map(c =>
    `<button class="td-filter-btn" data-filter-country="${c === 'All' ? '' : c}">${c}</button>`
  ).join('');

  const monthBtns = ['All', ...months].map(m =>
    `<button class="td-filter-btn" data-filter-month="${m === 'All' ? '' : m}">${m === 'All' ? 'All' : getMonthLabel(m)}</button>`
  ).join('');

  return `<div class="container" style="padding:40px 0;">
<div id="tour-app">

<div class="td-controls">
  <input type="text" id="td-search" placeholder="Search band, venue, city…" autocomplete="off" />
  <div class="td-filter-group">
    <span class="td-filter-label">Country</span>
    <div class="td-filter-btns" id="td-country-btns">${countryBtns}</div>
  </div>
  <div class="td-filter-group">
    <span class="td-filter-label">Month</span>
    <div class="td-filter-btns" id="td-month-btns">${monthBtns}</div>
  </div>
</div>

<div id="td-count" class="td-count">${events.length} upcoming shows</div>

<div id="td-list">
${eventRows}
</div>

<div id="td-empty" class="td-empty" style="display:none;">No shows match your filters.</div>

</div>

<p style="font-size:0.78rem;color:#555;margin-top:20px;">International dates from <a href="${JAME_EVENTS}" target="_blank" rel="noopener">JaME World</a>. Japan dates from <a href="https://www.livefans.jp" target="_blank" rel="noopener">livefans.jp</a>. Updated ${scrapedAt}.</p>
</div>

<style>
#tour-app { max-width: 860px; margin: 0 auto; }
.td-controls { margin-bottom: 20px; display: flex; flex-direction: column; gap: 12px; background: #111; padding: 20px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.06); }
#td-search { background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 0.9rem; padding: 9px 14px; width: 100%; box-sizing: border-box; outline: none; }
#td-search:focus { border-color: rgba(236,172,13,0.4); }
.td-filter-group { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.td-filter-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,0.3); padding-top: 6px; white-space: nowrap; min-width: 52px; }
.td-filter-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.td-filter-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; color: rgba(255,255,255,0.5); cursor: pointer; font-size: 0.75rem; padding: 4px 11px; }
.td-filter-btn.active { background: rgba(236,172,13,0.12); border-color: rgba(236,172,13,0.5); color: #ecac0d; font-weight: 600; }
.td-count { font-size: 0.78rem; color: rgba(255,255,255,0.3); margin-bottom: 12px; }
.td-event { display: flex; gap: 14px; padding: 11px 0; border-bottom: 1px solid rgba(255,255,255,0.05); align-items: flex-start; }
.td-event:last-child { border-bottom: none; }
.td-date { flex-shrink: 0; min-width: 100px; font-size: 0.8rem; color: #ecac0d; font-weight: 700; padding-top: 2px; line-height: 1.4; }
.td-info { flex: 1; min-width: 0; }
.td-title { font-size: 0.92rem; font-weight: 600; margin-bottom: 4px; }
.td-title a { color: #fff; text-decoration: none; }
.td-title a:hover { color: #ecac0d; }
.td-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.td-artist { font-size: 0.78rem; color: rgba(255,255,255,0.55); }
.td-venue { font-size: 0.78rem; color: rgba(255,255,255,0.35); }
.td-badge { font-size: 0.65rem; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 7px; border-radius: 20px; }
.td-badge--intl { background: rgba(236,172,13,0.1); border: 1px solid rgba(236,172,13,0.25); color: #ecac0d; }
.td-empty { color: rgba(255,255,255,0.3); font-style: italic; padding: 24px 0; }
</style>

<script>
(function() {
  var activeCountry = '';
  var activeMonth   = '';
  function setActive(group, btn) {
    group.querySelectorAll('.td-filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
  }
  function applyFilters() {
    var search  = document.getElementById('td-search').value.toLowerCase().trim();
    var events  = document.querySelectorAll('.td-event');
    var visible = 0;
    events.forEach(function(el) {
      var show = (!activeCountry || el.dataset.country === activeCountry) &&
                 (!activeMonth   || el.dataset.month   === activeMonth)   &&
                 (!search        || el.dataset.search.includes(search));
      el.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    document.getElementById('td-count').textContent = visible + ' show' + (visible !== 1 ? 's' : '') + ' found';
    document.getElementById('td-empty').style.display = visible === 0 ? '' : 'none';
  }
  document.getElementById('td-country-btns').addEventListener('click', function(e) {
    if (!e.target.matches('.td-filter-btn')) return;
    activeCountry = e.target.dataset.filterCountry;
    setActive(this, e.target);
    applyFilters();
  });
  document.getElementById('td-month-btns').addEventListener('click', function(e) {
    if (!e.target.matches('.td-filter-btn')) return;
    activeMonth = e.target.dataset.filterMonth;
    setActive(this, e.target);
    applyFilters();
  });
  document.getElementById('td-search').addEventListener('input', applyFilters);
  document.querySelector('#td-country-btns .td-filter-btn').classList.add('active');
  document.querySelector('#td-month-btns .td-filter-btn').classList.add('active');
})();
</script>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Scraping JaME World tour dates...');
  let jameEvents = [];
  try {
    jameEvents = await scrapeJameEvents();
  } catch (err) {
    console.error(`JaME scrape failed: ${err.message}`);
  }
  console.log(`→ ${jameEvents.length} international events from JaME`);

  console.log('Scraping livefans.jp upcoming Japan shows...');
  const livefansEvents = await scrapeLivefansUpcoming();

  const events = [...jameEvents, ...livefansEvents];
  console.log(`→ ${events.length} total events`);

  const scrapedAt = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const content   = buildTourContent(events, scrapedAt);

  updateJekyllPage(
    'tour-dates/index.html',
    { layout: 'default', title: 'VK Tour Dates', permalink: '/tour-dates/' },
    content,
    'Update tour dates page',
  );
  console.log('✓ Done.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
