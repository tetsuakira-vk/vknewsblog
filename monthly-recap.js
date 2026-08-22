/**
 * monthly-recap.js — VK Month in Review
 *
 * On the 1st of each month, reads last month's posts from recent-posts.json,
 * uses Claude to write a "Month in Review" summary post, and publishes it as
 * a Jekyll markdown post.
 *
 * Usage:
 *   node monthly-recap.js             — auto-detects last month
 *   node monthly-recap.js --dry-run   — print post to console, don't publish
 *   node monthly-recap.js --force     — run even if today is not the 1st
 *
 * Cron (1st of each month, 9am):
 *   0 9 1 * * cd /Users/robertnelson/vknewsblog && /usr/local/bin/node monthly-recap.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { publishToJekyll } from './lib/jekyll.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const RECENT_POSTS_FILE = './recent-posts.json';

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

// ─── Load last month's posts from local JSON ──────────────────────────────────

function fetchPostsInRange(start, end) {
  if (!existsSync(RECENT_POSTS_FILE)) return [];
  try {
    const all = JSON.parse(readFileSync(RECENT_POSTS_FILE, 'utf8'));
    return all.filter(p => {
      const d = new Date(p.published);
      return d >= start && d <= end &&
        !p.title?.includes('Month in Review') &&
        !p.title?.includes('Week in Review');
    });
  } catch { return []; }
}

// ─── Summarise with Claude ────────────────────────────────────────────────────

async function generateRecap(posts, month) {
  const postList = posts.map((p, i) => {
    const labels = (p.labels || []).join(', ');
    return `${i + 1}. "${p.title}" [${labels}] — ${p.url}`;
  }).join('\n');

  const prompt = `You are the editor of VK Chronicle (vkchronicle.com), an English-language Visual Kei music blog.

Below is a list of all news stories we published during ${month}. Write a "Month in Review" blog post that:

1. Opens with a punchy 1-sentence intro summarising the month's vibe for the VK scene
2. Covers the top 5–8 most significant stories in editorial paragraph form — group by theme where natural (e.g. "Tours & Live Events", "New Releases", "Band News")
3. Mentions quieter news briefly in a "Also This Month" bullet list
4. Closes with a 1-sentence forward look ("Looking ahead to [next month]...")

Tone: enthusiastic, editorial, like a music journalist who loves VK. 300–500 words.

Stories from ${month}:
${postList || '(No posts this month)'}

Return ONLY raw HTML using: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>, <a href="...">.
No wrappers. No markdown. No code fences.
Where you reference a story title, wrap it in a link using its URL from the list above.`;

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text.trim();
}

// ─── Build final content ──────────────────────────────────────────────────────

function buildPostContent(bodyHtml, posts, month) {
  const truncatedBody = bodyHtml.replace('</p>', '</p>\n<!--more-->');
  return `${truncatedBody}

<p style="margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.08);font-size:0.85rem;color:#999;">
  This roundup covers ${posts.length} post${posts.length !== 1 ? 's' : ''} published during ${month}.
  <a href="/">← Back to latest VK news</a>
</p>`;
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
  console.log(`Building ${month} recap...`);

  const posts = fetchPostsInRange(start, end);
  console.log(`  → Found ${posts.length} posts from ${month}`);

  if (posts.length === 0) {
    console.log('  → Nothing to recap. Skipping.');
    return;
  }

  const bodyHtml = await generateRecap(posts, month);
  const content  = buildPostContent(bodyHtml, posts, month);
  const title    = `Visual Kei ${month}: Month in Review`;

  if (DRY_RUN) {
    console.log('\n─────────────────────────────────────────────────────────');
    console.log(`TITLE: ${title}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(bodyHtml.slice(0, 1000), '\n...[truncated]');
    return;
  }

  const imageUrl = posts.find(p => p.image)?.image
    || 'https://vkchronicle.com/assets/images/placeholder.jpg';

  const postUrl = publishToJekyll(
    title,
    ['Month in Review', 'Visual Kei', 'News'],
    content,
    { imageUrl },
  );
  console.log(`  ✓ Published: ${postUrl}`);
}

main().catch(err => { console.error(err); process.exit(1); });
