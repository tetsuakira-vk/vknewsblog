/**
 * weekly-digest.js - Post a "This Week in Visual Kei" digest every Monday
 *
 * Reads the past 7 days of posts from recent-posts.json, asks Claude to write
 * a summary digest, then publishes it as a Jekyll markdown post.
 *
 * Usage: node weekly-digest.js
 * Cron (Monday 9am): 0 9 * * 1 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node weekly-digest.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { publishToJekyll, pingSitemap, SITE_REPO_PATH } from './lib/jekyll.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const RECENT_POSTS_FILE = './recent-posts.json';

// ─── Load last week's posts from local JSON ───────────────────────────────────

let _postsFiles = null;
function postFileExists(url) {
  if (!_postsFiles) {
    try { _postsFiles = readdirSync(path.join(SITE_REPO_PATH, '_posts')); }
    catch { _postsFiles = []; }
  }
  const slug = url.split('/').filter(Boolean).pop();
  return _postsFiles.some(f => f.endsWith(slug + '.md'));
}

function fetchRecentPosts(days = 7) {
  if (!existsSync(RECENT_POSTS_FILE)) return [];
  try {
    const all = JSON.parse(readFileSync(RECENT_POSTS_FILE, 'utf8'));
    const cutoff = new Date(Date.now() - days * 86400000);
    return all.filter(p => new Date(p.published) >= cutoff && postFileExists(p.url));
  } catch { return []; }
}

// ─── Claude digest writer ─────────────────────────────────────────────────────

async function writeDigest(posts, weekLabel) {
  const postList = posts
    .map((p, i) => `${i + 1}. ${p.title}${p.labels ? ` [${p.labels.join(', ')}]` : ''}`)
    .join('\n');

  const prompt = `You are the editor of VK Chronicle (vkchronicle.com), an English-language Visual Kei blog for Western fans.

Here are the posts published this week:
${postList}

Write a "This Week in Visual Kei" weekly digest post for the week of ${weekLabel}.

Guidelines:
- 300–450 words total
- Open with a brief scene-setter: what kind of week was it for VK? (busy, quiet, surprising, etc.)
- Group and summarise the week's news thematically (e.g. new releases, tour news, band updates)
- Mention specific bands and stories by name — don't be vague
- Keep it punchy and editorial — you're a VK fan talking to other fans
- End with a 1-sentence tease for what's coming up / what to watch for next week
- Tone: enthusiastic, knowledgeable, conversational

Write an SEO title:
- Format: "This Week in Visual Kei: [hook] — [Month Date, Year]"
- Max 70 characters

Respond in EXACTLY this format:
TITLE: [title]
CONTENT:
[digest body as plain paragraphs — no HTML tags]`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const titleMatch   = text.match(/^TITLE:\s*(.+)/m);
  const contentMatch = text.match(/^CONTENT:\n([\s\S]+)/m);

  if (!titleMatch || !contentMatch) throw new Error('Unexpected Claude response format');

  return {
    title:   titleMatch[1].trim(),
    content: contentMatch[1].trim(),
  };
}

// ─── Build markdown content ───────────────────────────────────────────────────

function buildDigestContent(digest, posts) {
  const linkList = posts.map(p => {
    const img = p.image
      ? `[![](${p.image})](${p.url})\n`
      : '';
    return `${img}- [${p.title}](${p.url})`;
  }).join('\n\n');

  return `${digest.content}

---

**This Week's Posts**

${linkList}`;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* non-fatal */ }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching last week's posts...");
  const posts = fetchRecentPosts(7);

  const newsPosts = posts.filter(p => !p.title.toLowerCase().includes('this week in visual kei'));

  if (newsPosts.length === 0) {
    console.log('No posts this week — skipping digest.');
    return;
  }

  console.log(`→ ${newsPosts.length} posts found`);

  const weekLabel = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  let digest;
  try {
    digest = await writeDigest(newsPosts, weekLabel);
  } catch (err) {
    console.error(`Claude error: ${err.message}`);
    return;
  }

  console.log(`  Title: "${digest.title}"`);

  const content = buildDigestContent(digest, newsPosts);
  const imageUrl = 'https://vkchronicle.com/assets/images/placeholder.jpg';

  const postUrl = publishToJekyll(
    digest.title,
    ['Visual Kei', 'Weekly Digest', 'News'],
    content,
    { imageUrl },
  );
  console.log(`  ✓ Digest posted: ${postUrl}`);

  await pingSitemap();
  await sendTelegram(`📋 <b>VK Chronicle weekly digest posted:</b> ${digest.title}`);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
