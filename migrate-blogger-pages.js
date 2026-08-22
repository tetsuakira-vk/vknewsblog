/**
 * migrate-blogger-pages.js
 * Extracts Blogger static PAGE entries from feed.atom and writes them
 * as Jekyll HTML files, then updates the Jekyll repo.
 *
 * Usage: node migrate-blogger-pages.js [--dry-run]
 */

import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { SITE_REPO_PATH, pushWithRebase } from './lib/jekyll.js';

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Pages to extract ────────────────────────────────────────────────────────

const PAGES = [
  { bloggerTitle: 'Start Here',                                  slug: 'start-here',            navTitle: 'Start Here' },
  { bloggerTitle: 'Getting Into Visual Kei: Where to Start',     slug: 'getting-into-visual-kei', navTitle: 'Getting Into Visual Kei' },
  { bloggerTitle: 'Visual Kei Explained: A Complete Guide',      slug: 'visual-kei-explained',   navTitle: 'Visual Kei Explained' },
  { bloggerTitle: 'If You Like... Visual Kei Band Recommendations', slug: 'if-you-like',         navTitle: 'If You Like…' },
  { bloggerTitle: 'VK Fashion',                                  slug: 'vk-fashion',             navTitle: 'VK Fashion' },
  { bloggerTitle: 'Is Visual Kei Dead?',                        slug: 'is-visual-kei-dead',     navTitle: 'Is Visual Kei Dead?' },
  { bloggerTitle: 'How To',                                      slug: 'how-to',                 navTitle: 'How To' },
];

// Internal Blogger link replacements (longest match first)
const LINK_REPLACEMENTS = [
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/getting-into-visual-kei[^"'\s)]*/g, '/getting-into-visual-kei/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/visual-kei-explained[^"'\s)]*/g,    '/visual-kei-explained/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/if-you-like[^"'\s)]*/g,             '/if-you-like/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/vk-fashion[^"'\s)]*/g,              '/vk-fashion/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/is-visual-kei-dead[^"'\s)]*/g,      '/is-visual-kei-dead/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/how-to[^"'\s)]*/g,                  '/how-to/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/start-here[^"'\s)]*/g,              '/start-here/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/best-visual-kei-albums[^"'\s)]*/g,  '/best-vk-albums/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/new-releases[^"'\s)]*/g,            '/releases/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/reviews[^"'\s)]*/g,                 '/reviews/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/bands[^"'\s)]*/g,                   '/bands/'],
  [/https?:\/\/vknyusu\.blogspot\.com\/p\/[^"'\s)]*/g,                        '/'],
  [/https?:\/\/vknyusu\.blogspot\.com\//g,                                    '/'],
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function decodeAtomText(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
}

function cleanContent(html) {
  // Strip LD+JSON blocks
  html = html.replace(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '');
  // Strip "More VK News" / related posts sections
  html = html.replace(/<div[^>]*class="[^"]*more-vk[^"]*"[\s\S]*?<\/div>/gi, '');
  // Fix internal links
  for (const [pattern, replacement] of LINK_REPLACEMENTS) {
    html = html.replace(pattern, replacement);
  }
  return html.trim();
}

function buildFrontMatter(title, permalink, description = '') {
  const safeTitle = title.replace(/"/g, '\\"');
  const safeDesc  = description.replace(/"/g, '\\"');
  let fm = `---\nlayout: default\ntitle: "${safeTitle}"\npermalink: ${permalink}\n`;
  if (safeDesc) fm += `description: "${safeDesc}"\n`;
  fm += `---\n\n`;
  return fm;
}

// ─── Parse feed.atom ─────────────────────────────────────────────────────────

function extractPages(atomPath) {
  const xml      = readFileSync(atomPath, 'utf-8');
  const raw      = xml.split('<entry>');
  const extracted = {};

  for (const entry of raw.slice(1)) {
    const typeMatch = entry.match(/<blogger:type>([^<]+)<\/blogger:type>/);
    if (!typeMatch || typeMatch[1] !== 'PAGE') continue;

    const titleMatch   = entry.match(/<title(?:[^>]*)>([^<]+)<\/title>/);
    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    if (!titleMatch || !contentMatch) continue;

    const title   = decodeAtomText(titleMatch[1]);
    const content = decodeAtomText(contentMatch[1]);
    extracted[title] = content;
  }

  return extracted;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const atomPath   = path.join('/Users/robertnelson/vknewsblog', 'feed.atom');
  const pageData   = extractPages(atomPath);
  const filePaths  = [];

  for (const page of PAGES) {
    const raw = pageData[page.bloggerTitle];
    if (!raw) {
      console.warn(`  ! Not found in atom: "${page.bloggerTitle}"`);
      continue;
    }

    const content    = cleanContent(raw);
    const permalink  = `/${page.slug}/`;
    const repoPath   = `${page.slug}/index.html`;
    const fullPath   = path.join(SITE_REPO_PATH, repoPath);

    // Wrap in container for centering; pages with .vk-guide have their own max-width
    const wrapped = `<div class="container" style="padding:40px 0;">\n${content}\n</div>\n`;
    const fileContent = buildFrontMatter(page.bloggerTitle, permalink) + wrapped;

    if (DRY_RUN) {
      console.log(`[dry-run] Would write: ${repoPath} (${fileContent.length} bytes)`);
      continue;
    }

    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, fileContent);
    filePaths.push(repoPath);
    console.log(`  ✓ Written: ${repoPath}`);
  }

  if (DRY_RUN || filePaths.length === 0) return;

  // Stage and commit
  for (const p of filePaths) {
    execSync(`git -C "${SITE_REPO_PATH}" add "${p}"`, { stdio: 'pipe' });
  }

  let hasStagedChanges = false;
  try { execSync(`git -C "${SITE_REPO_PATH}" diff --cached --quiet`, { stdio: 'pipe' }); }
  catch { hasStagedChanges = true; }

  if (!hasStagedChanges) { console.log('  (no changes to commit)'); return; }

  execSync(
    `git -C "${SITE_REPO_PATH}" commit -m "Migrate Blogger static pages to Jekyll"`,
    { stdio: 'pipe' }
  );
  pushWithRebase();
  console.log(`✓ Committed and pushed ${filePaths.length} page(s).`);
}

main();
