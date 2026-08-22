/**
 * fetch-weekly-embeds.js — YouTube MV search for this week's VK releases
 *
 * Scrapes vk.gy for releases in the past 7 days, searches YouTube for official
 * MVs using a whitelisted channel boost, writes _data/this_week.json.
 *
 * Search strategy per release:
 *   1. Open YouTube search for "artist title" (music category)
 *   2. Score results: title similarity + whitelist channel bonus + MV keyword bonus
 *   3. Accept if score >= 0.55, else try "artist title MV"
 *   4. Null if nothing confident — card shows buy links only
 *
 * Cron (Sunday 9:00am, before update-releases-page at 9:30am):
 *   0 9 * * 0 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node fetch-weekly-embeds.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { updateJekyllData, SITE_REPO_PATH } from './lib/jekyll.js';

const YT_KEY      = process.env.YOUTUBE_API_KEY;
const VKGY_BASE   = 'https://vk.gy';
const YT_SEARCH   = 'https://www.googleapis.com/youtube/v3/search';
const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const DAYS_BACK   = 7;
const delay       = ms => new Promise(r => setTimeout(r, ms));

// ─── Whitelisted VK channels ──────────────────────────────────────────────────
// Known IDs — extended at runtime by resolving handles below.
// Label channels provide the broadest coverage; artist channels are a fallback.

const VK_CHANNEL_IDS = new Set([
  'UCEsInI6avCL2afoAZX7nVdQ', // the GazettE (SMEJ)
  'UCKyHmQLIDdiLS7BBCowZEKw', // MUCC official
  'UCH4a3Uy6viB3eLuOqQY7sHA', // lynch.
  'UCq-drPYn0ayvF2Ph_FRrDbQ', // Plastic Tree
  'UC8P31-hpClUcVTTseZWVPGw', // JILUKA
  'UCshX7abyGGG2WqCuYC5En7w', // BUCK-TICK
  'UC3qZwXEOFHy-2qN9LrIvSqw', // PS Company (user-confirmed)
]);

// Handles resolved to IDs via YouTube Channels API at startup
const VK_CHANNEL_HANDLES = [
  'DangerCrueRecords',  // Danger Crue Records / MaverickDC Group
  'PSCOMPANYofficial',  // PS Company (handle form)
];

async function resolveHandles() {
  for (const handle of VK_CHANNEL_HANDLES) {
    try {
      const url = `${YT_CHANNELS}?part=id&forHandle=${handle}&key=${YT_KEY}`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const id   = data.items?.[0]?.id;
      if (id) { VK_CHANNEL_IDS.add(id); console.log(`  @${handle} → ${id}`); }
    } catch (e) { console.warn(`  Could not resolve @${handle}: ${e.message}`); }
    await delay(200);
  }
}

// ─── Title similarity ─────────────────────────────────────────────────────────

function norm(s) {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleSim(videoTitle, releaseStr) {
  const a = norm(videoTitle), b = norm(releaseStr);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const toksA = a.split(' ').filter(t => t.length > 1);
  const toksB = new Set(b.split(' ').filter(t => t.length > 1));
  const inter  = toksA.filter(t => toksB.has(t)).length;
  const denom  = Math.max(toksA.length, toksB.size, 1);
  return inter / denom;
}

// ─── YouTube search ───────────────────────────────────────────────────────────

async function ytSearch(query) {
  const params = new URLSearchParams({
    part: 'snippet', q: query, type: 'video',
    videoCategoryId: '10', maxResults: 5, key: YT_KEY,
  });
  try {
    const res  = await fetch(`${YT_SEARCH}?${params}`, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.error) { console.warn(`  YT API error: ${data.error.message}`); return []; }
    return data.items || [];
  } catch (e) { console.warn(`  YT fetch error: ${e.message}`); return []; }
}

function scoreItem(item, artist, title) {
  const vt           = item.snippet.title || '';
  const channelTitle = item.snippet.channelTitle || '';
  const channelId    = item.snippet.channelId || '';
  const isWhitelist  = VK_CHANNEL_IDS.has(channelId);

  // ── Artist / channel match (primary signal — more reliable than video title) ──
  // YouTube auto-generates "{Artist} - Topic" channels for distributed music.
  // These are high-confidence: if topic artist matches our artist, trust it strongly.
  const topicArtist    = channelTitle.endsWith(' - Topic') ? channelTitle.slice(0, -8) : null;
  const topicMatch     = topicArtist ? titleSim(topicArtist, artist) : 0;
  const channelSim     = titleSim(channelTitle, artist);
  const channelArtist  = Math.max(topicMatch, channelSim); // best channel-level artist signal

  // ── Title match ──────────────────────────────────────────────────────────────
  const titleScore = Math.max(titleSim(vt, title), titleSim(vt, `${artist} ${title}`));

  // ── Bonuses ──────────────────────────────────────────────────────────────────
  const topicBonus     = topicMatch > 0.6 ? 0.3 : 0;   // official distributor auto-channel
  const whitelistBonus = isWhitelist ? 0.25 : 0;
  const mvBonus        = /\b(MV|M\.V\.|Music Video|Official Video|Official MV|official)\b/i.test(vt) ? 0.08 : 0;

  // ── Artist penalty ───────────────────────────────────────────────────────────
  // If the channel clearly isn't the artist (and we have no other trust signal),
  // apply a heavy penalty. This catches "Jekyll and Hyde" → Five Finger Death Punch,
  // "Sakura" → random uploader, etc.
  const artistPenalty = (!isWhitelist && channelArtist < 0.25) ? -0.45 : 0;

  return Math.min(1, Math.max(0, titleScore + topicBonus + whitelistBonus + mvBonus + artistPenalty));
}

// Strip Japanese punctuation/brackets so 「JEKYLL」 searches as JEKYLL
function stripJpPunctuation(s) {
  return s.replace(/[「」『』【】〔〕〈〉《》・～〜]/g, '').replace(/\s+/g, ' ').trim();
}

async function searchYouTube(artist, title) {
  const t = stripJpPunctuation(title);
  const queries = [
    `"${artist}" "${t}"`,
    `${artist} ${t} MV`,
    `${artist} ${t} Official`,
  ];
  for (const query of queries) {
    await delay(250);
    const items = await ytSearch(query);
    if (!items.length) continue;
    const best = items
      .map(item => ({ item, score: scoreItem(item, artist, title) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best.score >= 0.6) {
      return {
        youtube_id:      best.item.id.videoId,
        youtube_channel: best.item.snippet.channelTitle,
        from_whitelist:  VK_CHANNEL_IDS.has(best.item.snippet.channelId),
        score:           Math.round(best.score * 100) / 100,
      };
    }
  }
  return null;
}

// ─── vk.gy scraper (this week only) ──────────────────────────────────────────

async function scrapeThisWeek() {
  const now     = new Date();
  const weekAgo = new Date(now.getTime() - DAYS_BACK * 86400000);
  const pastStr = weekAgo.toISOString().slice(0, 10);
  const nowStr  = now.toISOString().slice(0, 10);

  const months = new Set();
  const cursor = new Date(weekAgo);
  while (cursor <= now) {
    months.add(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setDate(cursor.getDate() + 8);
  }

  const releases = [], seen = new Set();

  for (const month of months) {
    try {
      const res = await fetch(`${VKGY_BASE}/releases/?month=${month}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const $ = cheerio.load(await res.text());

      $('div.module--release').each((_, el) => {
        const $c      = $(el);
        const dateText = $c.find('.release-card__date').first().text().trim();
        if (!dateText || dateText < pastStr || dateText > nowStr) return;

        const href = $c.find('a.card__link').first().attr('href') || '';
        const url  = href.startsWith('http') ? href : VKGY_BASE + href;
        if (seen.has(url)) return;
        seen.add(url);

        const $a   = $c.find('a.release-card__artist');
        const artist = $a.find('span.any--en').first().text().trim() || $a.text().trim();
        const $t   = $c.find('a.release-card__title');
        const title  = $t.find('span.any--en').first().text().trim() || $t.text().trim();
        const imgSrc = $c.find('img.release-card__cover').first().attr('src') || '';
        const image  = imgSrc ? (imgSrc.startsWith('http') ? imgSrc : VKGY_BASE + imgSrc) : null;

        if (artist && title) releases.push({ artist, title, date: dateText, image, vkgy_url: url });
      });
    } catch (e) { console.warn(`  vk.gy error for ${month}: ${e.message}`); }
    await delay(500);
  }

  const deduped = new Set();
  return releases
    .filter(r => { const k = `${r.artist}::${r.title}`; if (deduped.has(k)) return false; deduped.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Buy links ────────────────────────────────────────────────────────────────

function buyLinks(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    cdjapan: `https://www.cdjapan.co.jp/searchuni?term.mo=${q}&type=title`,
    amazon:  `https://www.amazon.co.jp/s?k=${q}&i=music-jp`,
    yesasia: `https://www.yesasia.com/global/search/?query=${q}&search_url=1&section=music`,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('── fetch-weekly-embeds ──');
  if (!YT_KEY) { console.error('YOUTUBE_API_KEY missing from .env'); process.exit(1); }

  console.log('Resolving channel handles...');
  await resolveHandles();

  console.log(`Scraping vk.gy for past ${DAYS_BACK} days...`);
  const releases = await scrapeThisWeek();
  console.log(`  → ${releases.length} releases found`);

  if (!releases.length) {
    console.log('Nothing found — check vk.gy selectors.');
    return;
  }

  console.log('Searching YouTube for MVs...');
  const enriched = [];
  for (const r of releases) {
    process.stdout.write(`  ${r.artist} — ${r.title}... `);
    const yt = await searchYouTube(r.artist, r.title);
    const links = buyLinks(r.artist, r.title);
    enriched.push({
      artist:          r.artist,
      title:           r.title,
      date:            r.date,
      image:           r.image,
      vkgy_url:        r.vkgy_url,
      youtube_id:      yt?.youtube_id || null,
      youtube_channel: yt?.youtube_channel || null,
      from_whitelist:  yt?.from_whitelist || false,
      ...links,
    });
    if (yt) {
      const flag = yt.from_whitelist ? ' [whitelist]' : '';
      console.log(`✓ ${yt.youtube_channel}${flag} (${yt.score})`);
    } else {
      console.log('no match — buy links only');
    }
  }

  const matched = enriched.filter(r => r.youtube_id).length;
  updateJekyllData('this_week.json', enriched, 'Update this weeks VK releases with YouTube embeds');
  console.log(`✓ Done — ${matched}/${enriched.length} matched to YouTube.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
