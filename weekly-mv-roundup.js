/**
 * weekly-mv-roundup.js — VK Music Videos This Week
 *
 * Every Friday, searches YouTube for Visual Kei MVs from the past 7 days,
 * publishes a Jekyll post with embedded videos, and saves the video IDs to
 * monthly-videos.json so the monthly roundup picks them up automatically.
 *
 * Usage:
 *   node weekly-mv-roundup.js             — auto, runs on Friday only
 *   node weekly-mv-roundup.js --force     — run on any day
 *   node weekly-mv-roundup.js --dry-run   — print post, don't publish
 *
 * Cron (every Friday, 2pm):
 *   0 14 * * 5 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node weekly-mv-roundup.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { publishToJekyll, SITE_BASE_URL } from './lib/jekyll.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MONTHLY_VIDEOS_FILE = './monthly-videos.json';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');

// ─── Date helpers ─────────────────────────────────────────────────────────────

function weekRange() {
  const end   = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

function formatDateRange(start, end) {
  const opts = { day: 'numeric', month: 'long' };
  const s = start.toLocaleDateString('en-AU', opts);
  const e = end.toLocaleDateString('en-AU', { ...opts, year: 'numeric' });
  return `${s} – ${e}`;
}

// ─── YouTube search ───────────────────────────────────────────────────────────

async function searchYoutube(start, end) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY not set in .env');

  const queries = [
    'visual kei MV official',
    'ヴィジュアル系 MV 新曲',
    'visual kei new single official',
    'jrock visual kei music video',
  ];

  const seen    = new Set();
  const results = [];

  for (const q of queries) {
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('q', q);
      url.searchParams.set('type', 'video');
      url.searchParams.set('order', 'date');
      url.searchParams.set('publishedAfter', start.toISOString());
      url.searchParams.set('publishedBefore', end.toISOString());
      url.searchParams.set('maxResults', '20');
      url.searchParams.set('key', apiKey);

      const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { console.warn(`  ! YouTube API ${res.status} for "${q}"`); continue; }

      const data = await res.json();
      for (const item of data.items || []) {
        const videoId = item.id?.videoId;
        if (!videoId || seen.has(videoId)) continue;
        seen.add(videoId);
        results.push({
          videoId,
          postTitle:   item.snippet?.title       || '',
          artist:      item.snippet?.channelTitle || '',
          publishedAt: item.snippet?.publishedAt  || new Date().toISOString(),
          thumbnail:   item.snippet?.thumbnails?.medium?.url || null,
        });
      }
    } catch (err) {
      console.warn(`  ! YouTube error for "${q}": ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

// ─── Filter with Claude ───────────────────────────────────────────────────────

async function filterToVK(videos) {
  if (videos.length === 0) return [];

  const list = videos.map((v, i) =>
    `${i + 1}. "${v.postTitle}" by ${v.artist}`
  ).join('\n');

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `You are a Visual Kei expert. From the following YouTube video list, return ONLY the numbers of videos that are genuine Visual Kei or J-rock music videos (official MVs, live clips, or lyric videos from VK bands). Exclude covers, reaction videos, fan edits, tutorials, non-VK content, and Western bands.

${list}

Reply with ONLY a comma-separated list of numbers, e.g.: 1,3,5,7
If none qualify, reply with: none`,
    }],
  });

  const reply = msg.content[0].text.trim();
  if (reply === 'none') return [];

  const indices = reply.split(',')
    .map(s => parseInt(s.trim(), 10) - 1)
    .filter(i => i >= 0 && i < videos.length);

  return indices.map(i => videos[i]);
}

// ─── Save to monthly-videos.json ──────────────────────────────────────────────

function saveToMonthlyFile(videos) {
  let existing = [];
  if (existsSync(MONTHLY_VIDEOS_FILE)) {
    try { existing = JSON.parse(readFileSync(MONTHLY_VIDEOS_FILE, 'utf8')); } catch { existing = []; }
  }

  const existingIds = new Set(existing.map(v => v.videoId));
  let added = 0;

  for (const v of videos) {
    if (existingIds.has(v.videoId)) continue;
    existing.push({
      videoId:   v.videoId,
      postTitle: v.postTitle,
      artist:    v.artist,
      addedAt:   new Date().toISOString(),
      source:    'weekly-mv-roundup',
    });
    added++;
  }

  writeFileSync(MONTHLY_VIDEOS_FILE, JSON.stringify(existing, null, 2));
  return added;
}

// ─── Generate intro ───────────────────────────────────────────────────────────

async function generateIntro(videos, dateRange) {
  const list = videos.slice(0, 12).map(v =>
    v.artist ? `${v.artist} — ${v.postTitle}` : v.postTitle
  ).join(', ');

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Write a short, punchy 2-sentence intro for a "VK Music Videos This Week" blog post covering ${dateRange}. Videos this week include: ${list}. Tone: excited VK fan, editorial voice. Return only the paragraph, no extra text.`,
    }],
  });
  return msg.content[0].text.trim().replace(/^#+\s+[^\n]+\n+/, '');
}

// ─── Build post HTML ──────────────────────────────────────────────────────────

function buildEmbed(videoId) {
  return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin-bottom:6px;">
  <iframe src="https://www.youtube.com/embed/${videoId}"
    style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
    allowfullscreen loading="lazy"></iframe>
</div>`;
}

function buildPostContent(videos, intro, dateRange) {
  const now = new Date().toISOString();
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    'headline': `VK Music Videos This Week — ${dateRange}`,
    'description': `${videos.length} new Visual Kei music videos from this week.`,
    'datePublished': now,
    'dateModified': now,
    'inLanguage': 'en',
    'keywords': 'Visual Kei, music video, MV, Japanese rock, weekly',
    'author':    { '@type': 'Organization', 'name': 'VK Chronicle', 'url': SITE_BASE_URL },
    'publisher': { '@type': 'Organization', 'name': 'VK Chronicle', 'url': SITE_BASE_URL },
  });

  const videoBlocks = videos.map(v => `<div class="mv-item">
  ${buildEmbed(v.videoId)}
  <p class="mv-label">${v.artist ? `<strong>${v.artist}</strong> — ` : ''}${v.postTitle}</p>
</div>`).join('\n');

  return `<script type="application/ld+json">${schema}</script>

<p>${intro}</p>

<!--more-->

<div class="mv-grid">
${videoBlocks}
</div>

<p style="margin-top:2em;font-size:0.85rem;color:#999;">
  Check the <a href="/tour-dates/">Tour Dates</a> page for upcoming live shows, or browse <a href="/">latest VK news</a>.
</p>

<style>
.mv-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin: 1.5em 0; }
.mv-item { }
.mv-label { font-size: 0.82rem; color: rgba(255,255,255,0.55); margin: 4px 0 0; }
.mv-label strong { color: #fff; }
@media (max-width: 640px) { .mv-grid { grid-template-columns: 1fr; } }
</style>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date();
  if (today.getDay() !== 5 && !FORCE) {
    console.log(`  → Skipping: today is not Friday. Use --force to override.`);
    return;
  }

  const { start, end } = weekRange();
  const dateRange = formatDateRange(start, end);
  console.log(`Building weekly MV roundup for ${dateRange}...`);

  console.log('  → Searching YouTube...');
  const raw = await searchYoutube(start, end);
  console.log(`  → ${raw.length} raw results`);

  if (raw.length === 0) {
    console.log('  → No videos found. Skipping.');
    return;
  }

  console.log('  → Filtering with Claude...');
  const videos = await filterToVK(raw);
  console.log(`  → ${videos.length} VK videos after filtering`);

  if (videos.length === 0) {
    console.log('  → No VK videos after filtering. Skipping.');
    return;
  }

  const added = saveToMonthlyFile(videos);
  console.log(`  → ${added} new video(s) saved to monthly-videos.json`);

  const intro   = await generateIntro(videos, dateRange);
  const title   = `VK Music Videos This Week — ${dateRange}`;
  const content = buildPostContent(videos, intro, dateRange);

  if (DRY_RUN) {
    console.log(`\nTITLE: ${title}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(`${videos.length} videos:`);
    for (const v of videos) console.log(`  ${v.artist} — ${v.postTitle}`);
    return;
  }

  const imageUrl = `https://img.youtube.com/vi/${videos[0].videoId}/maxresdefault.jpg`;

  const postUrl = publishToJekyll(
    title,
    ['Visual Kei', 'Music Video', 'Weekly'],
    content,
    { imageUrl },
  );
  console.log(`  ✓ Published: ${postUrl}`);
}

main().catch(err => { console.error(err); process.exit(1); });
