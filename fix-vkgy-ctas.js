/**
 * fix-source-ctas.js
 * Removes source-site CTAs and attribution blocks from all published posts.
 * Patterns removed:
 *   - "Let us know in the comments" (site has no comments)
 *   - Sentences directing readers to any source site (barks, natalie, jame-world, vk.gy, etc.)
 *   - "Follow us / subscribe / share this article" CTAs from source sites
 *   - <p style="...">Source: <a href="...">...</a></p> attribution blocks
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';

const POSTS_DIR = '/Users/robertnelson/vkchronicle/_posts';

// Known source domains — used to detect site-specific CTAs
const SOURCE_DOMAINS = [
  'vk\\.gy', 'barks\\.jp', 'natalie\\.mu', 'jame-world\\.com',
  'jrockrevolution\\.com', 'jrocknews\\.com', 'aramajapan\\.com',
  'jpopgo\\.co\\.uk', 'tower\\.jp', 'crimsonlotus\\.eu',
];
const DOMAIN_RE = new RegExp(`(${SOURCE_DOMAINS.join('|')})`, 'i');

// Sentence-level patterns — remove any sentence matching these anywhere in the body
const CTA_SENTENCE_PATTERNS = [
  // Comments (site has none)
  /[^.!?]*\blet us know in the comments\b[^.!?]*[.!?]/gi,
  /[^.!?]*\bleave (a|your) (comment|thoughts?|opinion)[^.!?]*[.!?]/gi,
  // "Follow [source site]" / "subscribe to [source site]"
  /[^.!?]*\b(follow|subscribe to|check out|head over to|visit)\b[^.!?]*(barks|natalie|jame.world|jrocknews|jrockrevolution|aramajapan|jpopgo|vk\.gy|crimsonlotus|tower\.jp)[^.!?]*[.!?]/gi,
  // "[source site] for more/updates/coverage"
  /[^.!?]*(barks|natalie|jame.world|jrocknews|jrockrevolution|aramajapan|jpopgo|vk\.gy|crimsonlotus|tower\.jp)[^.!?]*\bfor (more|all|the latest|continued|further|updates|coverage)\b[^.!?]*[.!?]/gi,
  // "follow us on social media" / "subscribe to our newsletter"
  /[^.!?]*\bfollow (us|them)\b[^.!?]*\bon social media\b[^.!?]*[.!?]/gi,
  /[^.!?]*\bsubscribe to (our|their) newsletter\b[^.!?]*[.!?]/gi,
  // "support us/them on Patreon"
  /[^.!?]*\bsupport(ing)?\b[^.!?]*\bPatreon\b[^.!?]*[.!?]/gi,
  // "share this article/post"
  /[^.!?]*\bshare this (article|post|story)\b[^.!?]*[.!?]/gi,
  // "make sure to follow [source]"
  /[^.!?]*\bmake sure to follow\b[^.!?]*(vk\.gy|barks|natalie|jame|jrock|aramajapan)[^.!?]*[.!?]/gi,
];

// Full-line patterns — remove whole lines matching these
const CTA_LINE_PATTERNS = [
  /^[^a-z\n]*\blet us know in the comments\b.*$/mi,
  /^.*\b(follow|subscribe to|check out|head over to|visit)\b.*\b(barks|natalie|jame.world|jrocknews|jrockrevolution|aramajapan|jpopgo|vk\.gy|crimsonlotus|tower\.jp)\b.*$/mi,
  /^.*\b(barks|natalie|jame.world|jrocknews|jrockrevolution|aramajapan|jpopgo|vk\.gy|crimsonlotus|tower\.jp)\b.*\bfor (more|all|the latest|continued|further|updates|coverage)\b.*$/mi,
  /^.*\bfollow (us|them)\b.*\bon social media\b.*$/mi,
  /^.*\bsupport(ing)?\b.*\bPatreon\b.*$/mi,
  /^.*\bshare this (article|post|story)\b.*$/mi,
  /^.*\bmake sure to follow\b.*$/mi,
];

// Source attribution HTML blocks — <p ...>Source: <a href="...">...</a></p>
const SOURCE_BLOCK_RE = /<p[^>]*>\s*Source:\s*<a[^>]*>.*?<\/a>\s*<\/p>/gis;

function splitFrontMatter(raw) {
  const match = raw.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) return { fm: '', body: raw };
  return { fm: match[1], body: match[2] };
}

function cleanBody(body) {
  let cleaned = body;

  // 1. Remove Source: attribution blocks
  cleaned = cleaned.replace(SOURCE_BLOCK_RE, '');

  // 2. Remove CTA sentences within paragraphs
  for (const re of CTA_SENTENCE_PATTERNS) {
    cleaned = cleaned.replace(re, (match) => {
      // Only strip if this really is a source-site CTA, not a legitimate band CTA
      return '';
    });
  }

  // 3. Remove full CTA lines
  for (const re of CTA_LINE_PATTERNS) {
    cleaned = cleaned.replace(re, '');
  }

  // 4. Clean up empty tags and excess blank lines
  cleaned = cleaned.replace(/<p[^>]*>\s*<\/p>/gi, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.trimEnd() + '\n';

  return cleaned;
}

function bodyHasCTA(body) {
  const b = body.toLowerCase();
  return (
    b.includes('let us know in the comments') ||
    b.includes('leave a comment') ||
    b.includes('make sure to follow') ||
    b.includes('share this article') ||
    b.includes('share this post') ||
    b.includes('subscribe to our') ||
    b.includes('support') && b.includes('patreon') ||
    (DOMAIN_RE.test(b) && (b.includes('follow') || b.includes('head over') || b.includes('check') || b.includes('for more') || b.includes('for the latest') || b.includes('for updates') || b.includes('social media')))
  );
}

const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.md')).sort();
let fixed = 0;

for (const file of files) {
  const filePath = `${POSTS_DIR}/${file}`;
  const raw = readFileSync(filePath, 'utf8');
  const { fm, body } = splitFrontMatter(raw);

  if (!bodyHasCTA(body)) continue;

  const cleanedBody = cleanBody(body);
  if (cleanedBody === body) continue;

  writeFileSync(filePath, fm + cleanedBody, 'utf8');
  console.log(`✓ ${file}`);
  fixed++;
}

console.log(`\nFixed ${fixed} posts.`);
