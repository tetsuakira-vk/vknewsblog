/**
 * backfill-images.js — add image: front matter to recent _posts that are missing it.
 *
 * Fallback chain per post:
 *   1. youtube_id: in front matter → YouTube maxresdefault
 *   2. YouTube embed URL in post body → YouTube maxresdefault
 *   3. source: URL → fetch og:image
 *   4. Last.fm artist photo (artist extracted from title)
 *   5. Site placeholder
 *
 * Usage: node backfill-images.js [--limit=N] [--dry-run]
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { SITE_REPO_PATH, pushWithRebase } from './lib/jekyll.js';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT   = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '--limit=20').split('=')[1], 10);
const PLACEHOLDER = 'https://vkchronicle.com/assets/images/placeholder.jpg';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function proxied(url, w = 800) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${w}&output=jpg`;
}

async function isAccessible(url) {
  try {
    const res = await fetch(proxied(url, 400), { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const ct  = res.headers.get('content-type') || '';
    return res.ok && ct.startsWith('image/');
  } catch { return false; }
}

async function ogImage(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const res = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const img = $('meta[property="og:image"]').attr('content');
    return img?.startsWith('http') ? img : null;
  } catch { return null; }
}

async function lastfmPhoto(artistName) {
  if (!artistName) return null;
  try {
    const res = await fetch(`https://www.last.fm/music/${encodeURIComponent(artistName)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const img = $('meta[property="og:image"]').attr('content');
    return (img && img.startsWith('http') && !img.includes('placeholder') && !img.includes('/meta/') && !img.includes('/avatar')) ? img : null;
  } catch { return null; }
}

function extractArtist(title) {
  if (!title) return null;
  const m = title.match(/^(.+?)\s+(?:announces?|releases?|shares?|drops?|reveals?|unveils?|returns?|streams?|posts?|debuts?|forms?|launches?|previews?|teases?|confirms?|wins?|scores?|hits?)\b/i);
  return m ? m[1].trim() : title.split(/\s+/).slice(0, 3).join(' ');
}

function parseFrontMatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  return { fm: m[1], body: m[2] };
}

function getField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm'));
  return m ? m[1].trim() : null;
}

function extractYoutubeId(text) {
  const m = text.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  const m2 = text.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  return m2 ? m2[1] : null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const postsDir = path.join(SITE_REPO_PATH, '_posts');
  const files    = readdirSync(postsDir).sort().reverse().slice(0, LIMIT * 2); // grab extra, filter below

  const toFix = [];
  for (const file of files) {
    const full    = path.join(postsDir, file);
    const content = readFileSync(full, 'utf8');
    if (content.includes('\nimage:')) continue; // already has image
    toFix.push({ file, full, content });
    if (toFix.length >= LIMIT) break;
  }

  console.log(`Found ${toFix.length} posts without images (from last ${files.length} checked)`);
  if (toFix.length === 0) { console.log('Nothing to do.'); return; }

  const changed = [];

  for (const { file, full, content } of toFix) {
    const parsed = parseFrontMatter(content);
    if (!parsed) { console.log(`  ! Cannot parse: ${file}`); continue; }

    const { fm, body } = parsed;
    const title      = getField(fm, 'title');
    const sourceUrl  = getField(fm, 'source');
    const youtubeId  = getField(fm, 'youtube_id') || extractYoutubeId(body);

    console.log(`\n→ ${file}`);

    let imageUrl = null;

    // 1. YouTube thumbnail
    if (!imageUrl && youtubeId) {
      imageUrl = `https://img.youtube.com/vi/${youtubeId}/maxresdefault.jpg`;
      console.log(`  ✓ YouTube thumbnail: ${youtubeId}`);
    }

    // 2. Source og:image
    if (!imageUrl && sourceUrl) {
      console.log(`  → Fetching og:image from ${sourceUrl.slice(0, 60)}...`);
      imageUrl = await ogImage(sourceUrl);
      if (imageUrl) console.log(`  ✓ og:image found`);
    }

    // 3. Validate image is accessible
    if (imageUrl) {
      const ok = await isAccessible(imageUrl);
      if (!ok) {
        console.log(`  ✗ Image blocked, discarding`);
        imageUrl = null;
      }
    }

    // 4. Last.fm artist photo
    if (!imageUrl) {
      const artist = extractArtist(title);
      if (artist) {
        console.log(`  → Trying Last.fm for "${artist}"...`);
        imageUrl = await lastfmPhoto(artist);
        if (imageUrl) console.log(`  ✓ Last.fm photo found`);
      }
    }

    // 5. Placeholder
    if (!imageUrl) {
      imageUrl = PLACEHOLDER;
      console.log(`  → Using site placeholder`);
    }

    const finalUrl = imageUrl === PLACEHOLDER ? PLACEHOLDER : proxied(imageUrl);
    const newFm    = fm + `\nimage: "${finalUrl}"`;
    const newContent = `---\n${newFm}\n---\n${body}`;

    if (DRY_RUN) {
      console.log(`  [dry-run] Would set image: "${finalUrl.slice(0, 80)}..."`);
      continue;
    }

    writeFileSync(full, newContent);
    changed.push(`_posts/${file}`);
    console.log(`  ✓ Updated`);
  }

  if (changed.length === 0) { console.log('\nNothing changed.'); return; }

  for (const p of changed) {
    execSync(`git -C "${SITE_REPO_PATH}" add "${p}"`, { stdio: 'pipe' });
  }

  let hasStagedChanges = false;
  try { execSync(`git -C "${SITE_REPO_PATH}" diff --cached --quiet`, { stdio: 'pipe' }); }
  catch { hasStagedChanges = true; }

  if (!hasStagedChanges) { console.log('\n(no staged changes)'); return; }

  execSync(
    `git -C "${SITE_REPO_PATH}" commit -m "Backfill images on ${changed.length} post(s)"`,
    { stdio: 'pipe' }
  );
  pushWithRebase();
  console.log(`\n✓ Committed and pushed ${changed.length} post(s).`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
