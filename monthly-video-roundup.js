/**
 * monthly-video-roundup.js — Monthly VK Video Drop
 *
 * Publishes a "New Visual Kei Videos — [Month]" Jekyll post on the 1st of each month.
 *
 * Sources (combined + deduplicated):
 *   1. monthly-videos.json  — YouTube IDs captured by pipeline throughout the month
 *   2. YouTube Data API     — supplemental search for VK MVs (optional)
 *                             Requires YOUTUBE_API_KEY in .env
 *
 * Usage:
 *   node monthly-video-roundup.js             — auto, runs on 1st only
 *   node monthly-video-roundup.js --force     — run on any day
 *   node monthly-video-roundup.js --dry-run   — print post, don't publish
 *
 * Cron (1st of each month, 10am — after monthly-recap.js at 9am):
 *   0 10 1 * * cd /Users/robertnelson/vknewsblog && /usr/local/bin/node monthly-video-roundup.js >> /tmp/vknews.log 2>&1
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

function lastMonthRange() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  return { start, end };
}

function monthName(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ─── Load pipeline captures ───────────────────────────────────────────────────

function loadPipelineCaptures(start, end) {
  if (!existsSync(MONTHLY_VIDEOS_FILE)) return [];
  try {
    const all = JSON.parse(readFileSync(MONTHLY_VIDEOS_FILE, 'utf8'));
    return all.filter(v => {
      const d = new Date(v.addedAt);
      return d >= start && d <= end;
    });
  } catch { return []; }
}

function archivePipelineCaptures(end) {
  if (!existsSync(MONTHLY_VIDEOS_FILE)) return;
  try {
    const all       = JSON.parse(readFileSync(MONTHLY_VIDEOS_FILE, 'utf8'));
    const remaining = all.filter(v => new Date(v.addedAt) > end);
    writeFileSync(MONTHLY_VIDEOS_FILE, JSON.stringify(remaining, null, 2));
  } catch {}
}

// ─── YouTube API supplement ───────────────────────────────────────────────────

async function fetchYoutubeVideos(start, end) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.log('  → No YOUTUBE_API_KEY set, skipping YouTube API search');
    return [];
  }

  const queries = [
    'visual kei official MV',
    'ヴィジュアル系 MV',
    'visual kei new single',
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
      url.searchParams.set('maxResults', '25');
      url.searchParams.set('key', apiKey);

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { console.warn(`  ! YouTube API returned ${res.status} for "${q}"`); continue; }

      const data = await res.json();
      for (const item of data.items || []) {
        const videoId = item.id?.videoId;
        if (!videoId || seen.has(videoId)) continue;
        seen.add(videoId);
        results.push({
          videoId,
          postTitle: item.snippet?.title        || '',
          artist:    item.snippet?.channelTitle  || '',
          addedAt:   item.snippet?.publishedAt   || new Date().toISOString(),
          source:    'youtube-api',
        });
      }
    } catch (err) {
      console.warn(`  ! YouTube API error for "${q}": ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

async function fetchVideoTitle(videoId, apiKey) {
  if (!apiKey) return null;
  try {
    const url  = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0];
    return item ? { title: item.snippet.title, channel: item.snippet.channelTitle } : null;
  } catch { return null; }
}

// ─── Generate intro ───────────────────────────────────────────────────────────

async function generateIntro(videos, month) {
  const videoList = videos.map(v => v.postTitle || v.artist).join(', ');
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Write a short, enthusiastic 2-sentence intro paragraph for a "New Visual Kei Videos — ${month}" blog post. The videos this month include: ${videoList}. Tone: excited VK fan, editorial voice. Return only the paragraph, no extra text.`,
    }],
  });
  return msg.content[0].text.trim();
}

// ─── Build post content ───────────────────────────────────────────────────────

function buildEmbed(videoId) {
  return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin-bottom:6px;">
  <iframe src="https://www.youtube.com/embed/${videoId}"
    style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
    allowfullscreen loading="lazy"></iframe>
</div>`;
}

function buildPostContent(videos, intro, month) {
  const now    = new Date().toISOString();
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    'headline': `New Visual Kei Videos — ${month}`,
    'description': `${videos.length} new Visual Kei music videos and live clips from ${month}.`,
    'datePublished': now,
    'dateModified':  now,
    'inLanguage': 'en',
    'keywords': 'Visual Kei, music video, MV, Japanese rock',
    'author':    { '@type': 'Organization', 'name': 'VK Chronicle', 'url': SITE_BASE_URL },
    'publisher': { '@type': 'Organization', 'name': 'VK Chronicle', 'url': SITE_BASE_URL },
  });

  const useGrid = videos.length >= 4;
  const videoBlocks = useGrid
    ? `<div class="vr-grid">\n` +
      videos.map(v => `<div class="vr-item">
  ${buildEmbed(v.videoId)}
  <p class="vr-label">${v.artist ? `<strong>${v.artist}</strong> — ` : ''}${v.postTitle || ''}</p>
</div>`).join('\n') + `\n</div>`
    : videos.map(v => `<div class="vr-item vr-item--full">
  ${buildEmbed(v.videoId)}
  <p class="vr-label">${v.artist ? `<strong>${v.artist}</strong> — ` : ''}${v.postTitle || ''}</p>
</div>`).join('\n');

  return `<script type="application/ld+json">${schema}</script>

<p>${intro}</p>

${videoBlocks}

<p style="margin-top:2em;font-size:0.85rem;color:#999;">
  Miss a release? Check the <a href="/releases/">New Releases</a> page for the full monthly rundown, or browse <a href="/">latest VK news</a>.
</p>

<style>
.vr-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin: 1.5em 0; }
.vr-item { }
.vr-item--full { margin-bottom: 1.5em; }
.vr-label { font-size: 0.82rem; color: rgba(255,255,255,0.55); margin: 4px 0 0; }
.vr-label strong { color: #fff; }
@media (max-width: 640px) { .vr-grid { grid-template-columns: 1fr; } }
</style>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date();
  if (today.getDate() !== 1 && !FORCE) {
    console.log(`  → Skipping: today is the ${today.getDate()}, not the 1st. Use --force to override.`);
    return;
  }

  const { start, end } = lastMonthRange();
  const month = monthName(start);
  console.log(`Building video roundup for ${month}...`);

  const pipelineVideos = loadPipelineCaptures(start, end);
  console.log(`  → ${pipelineVideos.length} video(s) captured by pipeline`);

  const ytVideos = await fetchYoutubeVideos(start, end);
  console.log(`  → ${ytVideos.length} additional video(s) from YouTube API`);

  const seen      = new Set(pipelineVideos.map(v => v.videoId));
  const allVideos = [...pipelineVideos];
  for (const v of ytVideos) {
    if (!seen.has(v.videoId)) { seen.add(v.videoId); allVideos.push(v); }
  }
  console.log(`  → ${allVideos.length} unique video(s) total`);

  if (allVideos.length === 0) {
    console.log('  → No videos to post. Skipping.');
    return;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    for (const v of allVideos) {
      if (!v.postTitle) {
        const meta = await fetchVideoTitle(v.videoId, apiKey);
        if (meta) { v.postTitle = meta.title; v.artist = v.artist || meta.channel; }
      }
    }
  }

  const intro   = await generateIntro(allVideos, month);
  const title   = `New Visual Kei Videos — ${month}`;
  const content = buildPostContent(allVideos, intro, month);

  if (DRY_RUN) {
    console.log(`\nTITLE: ${title}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(content.slice(0, 1200), '\n...[truncated]');
    return;
  }

  const imageUrl = `https://img.youtube.com/vi/${allVideos[0].videoId}/maxresdefault.jpg`;

  const postUrl = publishToJekyll(
    title,
    ['Visual Kei', 'Music Video', 'Monthly Roundup'],
    content,
    { imageUrl },
  );
  console.log(`  ✓ Published: ${postUrl}`);

  archivePipelineCaptures(end);
  console.log('  → monthly-videos.json archived for next month');
}

main().catch(err => { console.error(err); process.exit(1); });
