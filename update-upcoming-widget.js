/**
 * update-upcoming-widget.js — Upcoming VK Releases sidebar data
 *
 * Scrapes vk.gy for releases in the next 3 weeks and writes the data to
 * _data/upcoming.json in the Jekyll site repo. The sidebar template reads
 * this automatically via site.data.upcoming.
 *
 * Usage: node update-upcoming-widget.js
 * Cron (weekly, Monday 8am):
 *   0 8 * * 1 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node update-upcoming-widget.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { updateJekyllData } from './lib/jekyll.js';

const VKGY_BASE   = 'https://vk.gy';
const WEEKS_AHEAD = 3;

// ─── Date helpers ─────────────────────────────────────────────────────────────

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatDate(dateText) {
  try {
    return new Date(dateText).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  } catch { return dateText; }
}

// ─── Scrape vk.gy ─────────────────────────────────────────────────────────────

async function scrapeUpcoming() {
  const now       = new Date();
  const cutoff    = new Date(now.getTime() + WEEKS_AHEAD * 7 * 86400000);
  const todayStr  = now.toISOString().slice(0, 10);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const keys      = [...new Set([monthKey(now), monthKey(cutoff)])];

  const releases = [];
  const seen     = new Set();

  for (const key of keys) {
    const urls = [
      `${VKGY_BASE}/releases/`,
      `${VKGY_BASE}/releases/?month=${key}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) { console.warn(`  ! vk.gy ${res.status} for ${url}`); continue; }

        const $ = cheerio.load(await res.text());

        $('div.module--release').each((_, el) => {
          const $card    = $(el);
          const dateText = $card.find('.release-card__date').first().text().trim();
          if (!dateText || dateText < todayStr || dateText > cutoffStr) return;

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
          releases.push({ artist, title, date: formatDate(dateText), rawDate: dateText, image, url: detailUrl });
        });

      } catch (err) {
        console.warn(`  ! Error fetching ${url}: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 400));
    }
  }

  const finalSeen = new Set();
  return releases
    .filter(r => {
      const key = `${r.artist}::${r.title}`;
      if (finalSeen.has(key)) return false;
      finalSeen.add(key);
      return true;
    })
    .sort((a, b) => a.rawDate.localeCompare(b.rawDate))
    .map(({ rawDate: _raw, ...rest }) => rest); // strip rawDate from output
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Scraping vk.gy for upcoming releases...');
  const releases = await scrapeUpcoming();
  console.log(`  → ${releases.length} releases in the next ${WEEKS_AHEAD} weeks`);

  updateJekyllData('upcoming.json', releases, 'Update upcoming releases widget data');
  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
