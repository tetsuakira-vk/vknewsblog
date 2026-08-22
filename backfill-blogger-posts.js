/**
 * backfill-blogger-posts.js
 *
 * Parses the Blogger Atom export (feed.atom) and writes all LIVE non-profile
 * posts as Jekyll _posts/*.md files to the vkchronicle repo in one batch commit.
 *
 * Usage:
 *   node backfill-blogger-posts.js --dry-run    # preview filenames only
 *   node backfill-blogger-posts.js              # write + commit
 *   node backfill-blogger-posts.js --limit=10   # write only first N posts
 */

import * as cheerio from 'cheerio';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { batchUpdateJekyll, SITE_REPO_PATH } from './lib/jekyll.js';

const ATOM_FILE  = './feed.atom';
const DRY_RUN    = process.argv.includes('--dry-run');
const limitArg   = process.argv.find(a => a.startsWith('--limit='));
const LIMIT      = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const SKIP_LABELS = new Set(['Band Profile']);

// ─── Parse Atom ───────────────────────────────────────────────────────────────

function parseAtom() {
  const xml = readFileSync(ATOM_FILE, 'utf8');
  const $   = cheerio.load(xml, { xmlMode: true });

  const posts = [];

  $('entry').each((_, el) => {
    const $el = $(el);

    const type   = $el.find('blogger\\:type').first().text().trim();
    const status = $el.find('blogger\\:status').first().text().trim();
    if (type !== 'POST' || status !== 'LIVE') return;

    const title     = $el.find('title').first().text().trim();
    const published = $el.find('published').first().text().trim();
    const content   = $el.find('content').first().text().trim();
    const filename  = $el.find('blogger\\:filename').first().text().trim();

    const labels = [];
    $el.find('category').each((_, cat) => {
      const scheme = $(cat).attr('scheme') || '';
      const term   = $(cat).attr('term')   || '';
      if (scheme.includes('blogger.com') && term && !term.startsWith('http')) {
        labels.push(term);
      }
    });

    if (labels.some(l => SKIP_LABELS.has(l))) return;
    if (!title || !content) return;

    // Derive slug from blogger:filename — /YYYY/MM/the-slug_optionalsuffix.html
    let slug = '';
    if (filename) {
      const m = filename.match(/\/[^/]+\/[^/]+\/([^_]+?)(?:_\d+)?\.html$/);
      slug = m ? m[1] : '';
    }
    if (!slug) {
      slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    }

    posts.push({ title, published, labels, content, slug });
  });

  return posts;
}

// ─── Content cleanup ──────────────────────────────────────────────────────────

function extractImage(html) {
  const m = html.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : null;
}

function cleanContent(html) {
  return html
    // Strip leading LD+JSON — stale Blogger-specific structured data
    .replace(/^\s*<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/i, '')
    // Strip "More VK News" trailing block — links back to old Blogger URLs
    .replace(/<div[^>]*>\s*<p[^>]*>More VK News<\/p>[\s\S]*?<\/div>\s*$/i, '')
    .trim();
}

// ─── Build post file ──────────────────────────────────────────────────────────

function buildPostFile(post, suffix = '') {
  const date     = new Date(post.published);
  const dateStr  = date.toISOString().split('T')[0];
  const slug     = post.slug + (suffix ? `-${suffix}` : '');
  const filename = `${dateStr}-${slug}.md`;

  const safeTitle  = post.title.replace(/"/g, '\\"');
  const labelsYaml = `[${post.labels.map(l => `"${l.replace(/"/g, '\\"')}"`).join(', ')}]`;
  const imageUrl   = extractImage(post.content);

  const fmLines = [
    '---',
    'layout: post',
    `title: "${safeTitle}"`,
    `date: ${date.toISOString()}`,
    `labels: ${labelsYaml}`,
  ];
  if (imageUrl) fmLines.push(`image: "${imageUrl}"`);
  fmLines.push('---', '');

  return {
    filename,
    filePath: `_posts/${filename}`,
    content:  fmLines.join('\n') + cleanContent(post.content) + '\n',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('Parsing feed.atom...');
  const posts = parseAtom();
  console.log(`→ ${posts.length} LIVE non-profile posts found`);

  // Existing posts in _posts/ — skip any that are already there
  const postsDir     = path.join(SITE_REPO_PATH, '_posts');
  const existingFiles = existsSync(postsDir)
    ? new Set(readdirSync(postsDir))
    : new Set();

  const slugCounts = {};
  const files = [];
  let skipped = 0;

  for (const post of posts) {
    if (files.length >= LIMIT) break;

    const dateStr = new Date(post.published).toISOString().split('T')[0];
    const dayKey  = `${dateStr}-${post.slug}`;
    slugCounts[dayKey] = (slugCounts[dayKey] || 0) + 1;
    const suffix = slugCounts[dayKey] > 1 ? String(slugCounts[dayKey]) : '';

    const { filename, filePath, content } = buildPostFile(post, suffix);

    if (!DRY_RUN && existingFiles.has(filename)) skipped++;

    files.push({ filePath, content });
    if (DRY_RUN) {
      const hasImg = !!extractImage(post.content);
      console.log(`  ${filename}  ${hasImg ? '🖼' : '  '}  [${post.labels.join(', ')}]`);
    }
  }

  console.log(`→ ${files.length} to write (${skipped} already exist, will overwrite with fixes)`);

  if (DRY_RUN) {
    console.log('\nDry run complete — no files written.');
    return;
  }

  if (files.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log(`Writing ${files.length} posts and committing...`);
  batchUpdateJekyll(files, '"_posts/*.md"', 'Backfill Blogger posts to Jekyll');
  console.log('✓ Done.');
}

main();
