/**
 * pipeline.js - Main VKNews pipeline
 *
 * Fetches the merged RSS feed, filters for Visual Kei content,
 * enriches each post with Claude Haiku (translate + rewrite), and posts to Blogger.
 *
 * Usage: npm start
 * Cron:  0 * * * * cd /Users/robertnelson/vknewsblog && npm start
 */

import 'dotenv/config';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import * as cheerio from 'cheerio';
import { fetchAndSavePopularAndBirthdays } from './fetch-popular.js';
import { pushWithRebase } from './lib/jekyll.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const POSTED_FILE = './posted.json';
const RECENT_TITLES_FILE = './recent-titles.json';
const REVIEWED_FILE = './reviewed-albums.json';
const MONTHLY_VIDEOS_FILE = './monthly-videos.json';
const RECENT_POSTS_FILE = './recent-posts.json';
const BAND_PROFILES_FILE = './band-profiles.json';
const SITE_REPO_PATH = process.env.SITE_REPO_PATH || '/Users/robertnelson/vkchronicle';
const SITE_BASE_URL = 'https://vkchronicle.com';
const MAX_POSTS_PER_RUN = 5;
const MAX_ITEM_AGE_DAYS = 30; // ignore feed items older than this
const DUPLICATE_WINDOW_HOURS = 720; // suppress same-band stories within this window (30 days)

// These sources are VK-dedicated — every item passes through
// NOTE: jrockrevolution.com, jrocknews.com, jame-world.com, aramajapan.com, jpopgo.co.uk
// cover ALL J-rock/J-pop (not VK-only), so they go through keyword filtering instead.
const VK_DEDICATED_DOMAINS = [
  'vk.gy',
  // 'forum.jrockone.com' removed — covers all J-rock, not VK-only; goes through keyword filter
  'crimsonlotus.eu',   // French VK promo site — 100% VK content
  'vkdb.jp',           // Japanese VK database — 100% VK content
  'club-zy.com',       // VK magazine/news site — 100% VK content
];

// Known non-VK J-rock/J-pop bands — blocked at the filter stage regardless of source.
// These are mainstream J-rock acts that occasionally appear in VK-adjacent sources.
const NON_VK_BANDS = [
  // Mainstream J-rock — never VK
  'the back horn', 'back horn',
  'cloudy', // newer J-rock, not VK
  'one ok rock',
  'radwimps',
  'mrs. green apple', 'mrs green apple',
  'the oral cigarettes', 'oral cigarettes',
  'king gnu',
  'official hige dandism', 'higedan',
  'yoasobi',
  'ado',
  'eve',
  'kenshi yonezu', 'hachi',
  'aimer',
  'lisa',
  'amazarashi',
  'asian kung-fu generation', 'akfg',
  'bump of chicken',
  'man with a mission', 'mwam',
  'the pillows',
  'ellegarden',
  'maximum the hormone',
  'golden bomber', // visual-style but comedy/not VK
  'bishonen', // idol not VK
  'my first story',
  'the oral cigarettes',
  'tricot',
  'kana-boon',
  'blue encount',
  'nico touches the walls',
  'sakanaction',
  'fling posse',
  'creepy nuts',
  'sekai no owari', 'sekai no owari',
  'kyary pamyu pamyu',
  'perfume',
  'babymetal', // metal-idol crossover, not VK
  'band-maid', // not VK
  'lovebites', // not VK
  'wagakki band', // Japanese instruments, not VK
  'silent siren',
  'scandal',
  'flow',
  'granrodeo',
  'high and mighty color',
  'sairui no ame',
  'cynhn',
];

// For barks.jp / tower.jp / natalie.mu / jrockrevolution.com / jrocknews.com / jame-world.com (general J-music/J-rock),
// only include if a VK keyword matches the title/snippet
const VK_KEYWORDS = [
  // Genre terms
  'visual kei', 'visual-kei', 'ヴィジュアル系', 'ビジュアル系',
  'kote-kei', 'angura-kei', 'oshare-kei', 'eroguro', 'nagoya-kei',
  // Established VK bands (add more as needed)
  'dir en grey', 'diru', 'the gazette', 'gazette', 'buck-tick',
  'sadie', 'mejibray', 'lynch.', 'exist†trace', 'versailles',
  'malice mizer', 'moi dix mois', 'nightmare', 'alice nine',
  'vistlip', 'kra', 'an cafe', 'lm.c', 'vidoll', 'merry',
  'girugamesh', 'kagrra', 'the black swan', 'suicide ali', 'kizu',
  'royz', 'kiryu', 'lycaon', 'born', 'deathgaze', 'ayabie',
  'baroque', 'vamps', 'gackt', 'hyde', 'l\'arc~en~ciel', 'laruku',
  'diaura', 'nazare', 'umbrella', 'rides in revellion',
  'fantome iris', 'the god and death stars', 'codomo dragon',
  'dadaroma', 'deviloof', 'razor', 'scapegoat', 'haisuinonasa',
  'jiluka', 'xaa-xaa', 'sarigia', 'megaromania', 'matenrou opera',
  // Additional active bands
  'luna sea', 'x japan', 'yoshiki', 'plastic tree', 'rentrer en soi',
  'angelo', 'kirito', 'develop one\'s faculties', 'dof',
  'the novembers', 'mucc', 'gazette', 'アルルカン', 'arlequin',
  'lycaon', 'viii', 'cali≠gari', 'sukekiyo', 'kyo',
  'la:sadie\'s', 'シド', 'sid', 'heidi.', 'pentagon',
  'dué le quartz', 'vidoll', 'fatima', 'no:name',
  'petit brabancon', 'chaidura', 'dimlim', 'memento mori',
  'hanabie', 'onmyo-za', 'onmyoza', 'd=out', 'dout', 'la:sadies',
  'miyavi', 'yoshiki', 'teru', 'sugizo', 'inoran',
];

// ─── Reviewed albums (for internal linking) ──────────────────────────────────

function loadReviewedAlbums() {
  if (!existsSync(REVIEWED_FILE)) return [];
  try { return JSON.parse(readFileSync(REVIEWED_FILE, 'utf8')); } catch { return []; }
}

function findRelatedReview(title, content, reviewedAlbums) {
  const haystack = (title + ' ' + content).toLowerCase();
  for (const r of reviewedAlbums) {
    if (!r.url || !r.artist) continue;
    const artist = r.artist.toLowerCase();
    if (artist.length > 3 && haystack.includes(artist)) return r;
  }
  return null;
}

// ─── Monthly video capture ────────────────────────────────────────────────────

function saveMonthlyVideo({ videoId, postTitle, postUrl, artist }) {
  if (!videoId) return;
  let videos = [];
  if (existsSync(MONTHLY_VIDEOS_FILE)) {
    try { videos = JSON.parse(readFileSync(MONTHLY_VIDEOS_FILE, 'utf8')); } catch { videos = []; }
  }
  // Deduplicate by videoId
  if (videos.some(v => v.videoId === videoId)) return;
  videos.push({ videoId, postTitle, postUrl, artist, addedAt: new Date().toISOString() });
  writeFileSync(MONTHLY_VIDEOS_FILE, JSON.stringify(videos, null, 2));
}

// ─── Recent posts (for related posts block) ───────────────────────────────────

function loadRecentPostsLocal() {
  if (!existsSync(RECENT_POSTS_FILE)) return [];
  try { return JSON.parse(readFileSync(RECENT_POSTS_FILE, 'utf8')); } catch { return []; }
}

function saveRecentPost({ title, url, published, labels, image }) {
  const posts = loadRecentPostsLocal();
  posts.unshift({ title, url, published, labels, image: image || null });
  writeFileSync(RECENT_POSTS_FILE, JSON.stringify(posts.slice(0, 60), null, 2));
}

function findRelatedPosts(postLabels, recentPosts) {
  if (!recentPosts?.length) return [];
  const artistLabel = (postLabels || []).find(l =>
    !['News', 'Visual Kei', 'Live Report', 'Album Release', 'Tour', 'Interview', 'Month in Review', 'Band Profile'].includes(l)
  );
  // Prefer posts sharing the same band/artist label, then fill with most recent
  const withSameArtist = artistLabel
    ? recentPosts.filter(p => (p.labels || []).includes(artistLabel))
    : [];
  const others = recentPosts.filter(p => !withSameArtist.includes(p));
  return [...withSameArtist, ...others].slice(0, 3);
}

// ─── Band profiles (for internal linking) ────────────────────────────────────

function normalizeBandName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function loadBandProfilesLocal() {
  // Returns Map: normalizedName → { name, url }
  if (!existsSync(BAND_PROFILES_FILE)) return new Map();
  try {
    const data = JSON.parse(readFileSync(BAND_PROFILES_FILE, 'utf8'));
    return new Map(Object.entries(data));
  } catch (err) {
    console.warn('  ! Could not load band profiles:', err.message);
  }
  return new Map();
}

function findBandProfile(postTitle, postContent, bandProfiles) {
  if (!bandProfiles?.size) return null;
  // Try extracting artist from title first (most reliable)
  const artist = extractArtistFromTitle(postTitle);
  if (artist) {
    const key = normalizeBandName(artist);
    if (bandProfiles.has(key)) return bandProfiles.get(key);
  }
  // Fallback: scan content for any known band name (longest match wins to avoid "the" matching "the GazettE")
  const haystack = postTitle.toLowerCase() + ' ' + postContent.toLowerCase();
  let best = null;
  for (const [key, profile] of bandProfiles) {
    if (key.length < 4) continue; // skip very short names
    if (haystack.includes(normalizeBandName(profile.name)) && (!best || profile.name.length > best.name.length)) {
      best = profile;
    }
  }
  return best;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isVKDedicatedSource(link = '') {
  return VK_DEDICATED_DOMAINS.some(domain => link.includes(domain));
}

// vk.gy self-promotional posts — playlists, roundups, site features — not news
const VKGY_SELFPROMO_SLUGS = [
  'playlist', 'new-releases-playlist', 'roundup', 'best-of', 'top-releases',
  'monthly-picks', 'weekly-picks', 'our-picks', 'we-recommend',
];
function isVKGYSelfPromo(link = '', title = '') {
  if (!link.includes('vk.gy')) return false;
  const slug  = link.toLowerCase();
  const lower = title.toLowerCase();
  return VKGY_SELFPROMO_SLUGS.some(kw => slug.includes(kw) || lower.includes(kw));
}

function hasVKKeyword(text = '') {
  const lower = text.toLowerCase();
  return VK_KEYWORDS.some(kw => lower.includes(kw));
}

function isNonVKBand(text = '') {
  const lower = text.toLowerCase();
  return NON_VK_BANDS.some(band => lower.includes(band));
}

function isVKContent(item) {
  const titleAndSnippet = [item.title, item.contentSnippet || ''].join(' ');
  // Blocklist check first — known non-VK bands always rejected, regardless of source
  if (isNonVKBand(titleAndSnippet)) return false;
  // vk.gy self-promotion (playlists, roundups) — not news, skip
  if (isVKGYSelfPromo(item.link, item.title)) return false;
  if (isVKDedicatedSource(item.link)) return true;
  // For general sources: only check title + short snippet, NOT full article body.
  // Checking full body causes false positives (e.g. non-VK article that mentions a VK band in passing).
  return hasVKKeyword(titleAndSnippet);
}

// ─── Duplicate story detection ────────────────────────────────────────────────

function loadRecentTitles() {
  if (!existsSync(RECENT_TITLES_FILE)) return [];
  try { return JSON.parse(readFileSync(RECENT_TITLES_FILE, 'utf8')); } catch { return []; }
}

function saveRecentTitles(titles) {
  const cutoff = Date.now() - DUPLICATE_WINDOW_HOURS * 3600 * 1000;
  writeFileSync(RECENT_TITLES_FILE, JSON.stringify(titles.filter(t => t.ts > cutoff), null, 2));
}

function isDuplicateStory(newTitle, recentTitles) {
  const cutoff = Date.now() - DUPLICATE_WINDOW_HOURS * 3600 * 1000;
  const newWords = newTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  for (const { title, ts } of recentTitles) {
    if (ts < cutoff) continue;
    const existingWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    // Count shared words — 3+ in common between short titles = likely same story
    const overlap = newWords.filter(w => existingWords.includes(w)).length;
    const threshold = Math.min(3, Math.floor(newWords.length * 0.4));
    if (overlap >= threshold) return true;
  }
  return false;
}

function itemId(item) {
  return item.guid || item.link;
}

// Extract all usable image URLs from feed item HTML content
function extractImagesFromFeedContent(htmlContent) {
  if (!htmlContent) return [];
  const $ = cheerio.load(htmlContent);
  const urls = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src || !src.startsWith('http')) return;
    const width = parseInt($(el).attr('width') || '9999', 10);
    if (width < 200) return; // skip tiny icons/spacers
    if (!urls.includes(src)) urls.push(src);
  });
  return urls;
}

function extractYoutubeId(html) {
  if (!html) return null;
  // Match embedded iframes first
  const iframeMatch = html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (iframeMatch) return iframeMatch[1];
  // Match watch URLs
  const watchMatch = html.match(/youtube\.com\/watch\?(?:[^"'\s]*&)?v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];
  // Match youtu.be short URLs
  const shortMatch = html.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  return null;
}

async function fetchArticleContent(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VKNewsBot/1.0; +https://vknyusu.blogspot.com)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return { text: null, image: null, youtubeId: null };
    const html = await res.text();
    const $ = cheerio.load(html);

    // Collect all images — og:image first, then article body images
    const images = [];
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage && ogImage.startsWith('http')) images.push(ogImage);

    $('article img, main img, .entry-content img, .post-body img, .article-body img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (!src || !src.startsWith('http')) return;
      const width = parseInt($(el).attr('width') || '9999', 10);
      if (width < 100) return;
      if (!images.includes(src)) images.push(src);
    });

    // Extract YouTube video ID from raw HTML before we strip scripts/iframes
    const youtubeId = extractYoutubeId(html);

    $('nav, header, footer, script, style, .ad, .ads, .advertisement, .sidebar, .related').remove();
    const text = ($('article').text() || $('main').text() || $('body').text())
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    return {
      text: text.length > 100 ? text : null,
      images,
      youtubeId,
    };
  } catch {
    return { text: null, image: null, youtubeId: null };
  }
}

// ─── Image validation ────────────────────────────────────────────────────────

async function isImageAccessible(url) {
  if (!url) return false;
  const proxied = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=400&output=jpg`;
  try {
    // Use GET with Range to actually pull a few bytes — HEAD passes on many servers
    // that block the real browser GET (hotlink protection, CDN rules, etc.)
    const res = await fetch(proxied, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(10000),
    });
    const ct = res.headers.get('content-type') || '';
    return (res.ok || res.status === 206) && ct.startsWith('image/');
  } catch {
    return false;
  }
}

// ─── YouTube thumbnail ────────────────────────────────────────────────────────

// Tries maxresdefault → hqdefault → mqdefault in order; returns first accessible URL.
// YouTube thumbnails are always public but maxresdefault doesn't exist for all videos.
async function fetchYoutubeThumbnail(videoId) {
  if (!videoId) return null;
  const qualities = ['maxresdefault', 'hqdefault', 'mqdefault'];
  for (const q of qualities) {
    const url = `https://img.youtube.com/vi/${videoId}/${q}.jpg`;
    const ok = await isImageAccessible(url);
    if (ok) {
      console.log(`  → YouTube thumbnail (${q}): ${videoId}`);
      return url;
    }
  }
  return null;
}

// ─── vk.gy artist image lookup ───────────────────────────────────────────────

const BAND_IMAGE_CACHE_FILE = './band-images.json';
const VKGY_NEGATIVE_TTL = 7 * 24 * 3600 * 1000; // re-check not-found entries after 7 days

function loadBandImageCache() {
  if (!existsSync(BAND_IMAGE_CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(BAND_IMAGE_CACHE_FILE, 'utf8')); } catch { return {}; }
}

function saveBandImageCache(cache) {
  writeFileSync(BAND_IMAGE_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// /images/176872/acme-multiple-people/ → https://vk.gy/images/176872-acme-multiple-people.jpg
function vkgyHrefToImageUrl(href) {
  const m = href.match(/\/images\/(\d+)\/([^/?&]+)/);
  if (!m) return null;
  return `https://vk.gy/images/${m[1]}-${m[2]}.jpg`;
}

function toVkgySlug(name) {
  return name.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchVkgyArtistImage(artistName) {
  if (!artistName) return null;

  const cache = loadBandImageCache();
  const key = artistName.toLowerCase().trim();
  const now = Date.now();

  // Positive hit — cached forever
  if (cache[key]?.url) return cache[key].url;
  // Negative hit — skip if recent
  if (cache[key] && cache[key].url === null && now - cache[key].ts < VKGY_NEGATIVE_TTL) return null;

  console.log(`  → vk.gy image lookup: "${artistName}"`);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; VKNewsBot/1.0; +https://vkchronicle.com)' };
  const miss = () => { cache[key] = { url: null, ts: now }; saveBandImageCache(cache); return null; };

  try {
    // Step 1: try the direct slug URL first
    let pageHtml = null;
    const slug = toVkgySlug(artistName);
    const directRes = await fetch(`https://vk.gy/${slug}`, { headers, signal: AbortSignal.timeout(10000) });
    if (directRes.ok) {
      const html = await directRes.text();
      if (html.includes('artist__') || html.includes('/images/')) pageHtml = html;
    }

    // Step 2: if direct miss, search for the artist
    if (!pageHtml) {
      const searchRes = await fetch(`https://vk.gy/?q=${encodeURIComponent(artistName)}`, {
        headers, signal: AbortSignal.timeout(10000),
      });
      if (!searchRes.ok) return miss();
      const searchHtml = await searchRes.text();
      const $s = cheerio.load(searchHtml);

      // Artist pages are at /{slug} — single path segment, no sub-paths
      let artistHref = null;
      $s('a[href]').each((_, el) => {
        if (artistHref) return;
        const href = $s(el).attr('href') || '';
        if (/^\/[a-z0-9][a-z0-9-]*$/.test(href)) artistHref = href;
      });
      if (!artistHref) return miss();

      const pageRes = await fetch(`https://vk.gy${artistHref}`, { headers, signal: AbortSignal.timeout(10000) });
      if (!pageRes.ok) return miss();
      pageHtml = await pageRes.text();
    }

    // Step 3: find a "multiple-people" gallery link (group photo)
    const $ = cheerio.load(pageHtml);
    const galleryHrefs = [];
    $('a[href*="/images/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/\/images\/\d+\/[^/]+/.test(href)) galleryHrefs.push(href);
    });

    const groupHref = galleryHrefs.find(h => h.includes('multiple-people'));
    if (!groupHref) return miss(); // no group photo — don't use single-member shots

    const imageUrl = vkgyHrefToImageUrl(groupHref);
    if (!imageUrl) return miss();

    // Step 4: verify it's actually accessible
    const ok = await isImageAccessible(imageUrl);
    if (!ok) return miss();

    console.log(`  → vk.gy group photo: ${imageUrl}`);
    cache[key] = { url: imageUrl, ts: now };
    saveBandImageCache(cache);
    return imageUrl;

  } catch (err) {
    console.warn(`  → vk.gy lookup failed for "${artistName}": ${err.message}`);
    return null; // don't cache errors — could be transient
  }
}

// ─── Last.fm artist photo fallback ───────────────────────────────────────────

// Query MusicBrainz for the canonical artist name, preferring results with
// a "visual kei" disambiguation — handles odd spellings and all-caps VK names.
async function canonicalizeVKArtistName(name) {
  if (!name) return name;
  try {
    const res = await fetch(
      `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(name)}&limit=5&fmt=json`,
      {
        headers: { 'User-Agent': 'VKChronicle/1.0 (vkchronicle.com)' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return name;
    const data = await res.json();
    const artists = data.artists || [];
    // Prefer a high-confidence result with visual kei disambiguation
    const vkMatch = artists.find(a =>
      a.score >= 60 && a.disambiguation?.toLowerCase().includes('visual kei')
    );
    if (vkMatch) return vkMatch.name;
    // Fall back to top result if confident enough
    if (artists[0]?.score >= 80) return artists[0].name;
    return name;
  } catch {
    return name;
  }
}

async function fetchItunesArtistImage(artistName) {
  if (!artistName) return null;
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&country=jp&entity=musicArtist&limit=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const artist = data.results?.[0];
    if (!artist?.artworkUrl100) return null;
    // Upscale the 100x100 thumbnail to 600x600
    return artist.artworkUrl100.replace('100x100bb', '600x600bb');
  } catch {
    return null;
  }
}

async function fetchArtistPhoto(artistName) {
  if (!artistName) return null;
  try {
    const url = `https://www.last.fm/music/${encodeURIComponent(artistName)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const img = $('meta[property="og:image"]').attr('content');
    const LASTFM_BLANK_HASH = '2a96cbd8b46e442fc41c2b86b821562f';
    if (img && img.startsWith('http') && !img.includes('placeholder') && !img.includes('/meta/') && !img.includes('/avatar') && !img.includes(LASTFM_BLANK_HASH)) return img;
    return null;
  } catch {
    return null;
  }
}

// Extract the artist name from a Claude-generated post title (first 1-3 words before a verb/preposition)
function extractArtistFromTitle(title) {
  if (!title) return null;
  // vkdb.jp sometimes formats soundtrack entries as "Original Soundtrack (Music by ARTIST)"
  const soundtrackMatch = title.match(/Original Soundtrack\s*\(Music by ([^)]+)\)/i);
  if (soundtrackMatch) return soundtrackMatch[1].trim();
  // Titles are like "Dir En Grey Announce...", "the GazettE Release...", "LUNA SEA Honor..."
  // Split on known verbs/connectors and take the prefix
  const m = title.match(/^(.+?)\s+(?:announces?|releases?|shares?|drops?|reveals?|unveils?|returns?|streams?|posts?|debuts?|tours?|performs?|launches?|previews?|teases?|honors?|marks?|celebrates?|signs?|joins?|leaves?|disbands?|reforms?|confirms?|wins?|scores?|hits?|collaborates?|covers?|reimagines?|revisits?|presents?)\b/i);
  if (m) return m[1].trim();
  // Fallback: first 3 words
  return title.split(/\s+/).slice(0, 3).join(' ');
}

// ─── Telegram notifications ───────────────────────────────────────────────────

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // silently skip if not configured
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Non-fatal — don't let a Telegram hiccup break the pipeline
  }
}

// ─── Claude enrichment ────────────────────────────────────────────────────────

async function enrichWithClaude(anthropic, item, rawContent, knownVKSource = false, extraImages = []) {
  const vkCheckInstructions = knownVKSource
    ? `1. This article is from a confirmed Visual Kei source. Write the post — do NOT output NOT_VK.`
    : `1. Determine if this article is about Visual Kei.
   Visual Kei is a Japanese rock movement defined by theatrical makeup, elaborate costumes, and androgynous aesthetics — think Dir En Grey, the GazettE, Buck-Tick, Malice Mizer, LUNA SEA, X Japan, Alice Nine, Versailles, DIAURA, KIZU, Nightmare, An Cafe, etc.

   Respond with only: NOT_VK if the article is about ANY of the following:
   - Mainstream J-rock that is NOT Visual Kei: ONE OK ROCK, RADWIMPS, The Back Horn, Cloudy, The Oral Cigarettes, Mrs. GREEN APPLE, King Gnu, Official HIGE DANdism, YOASOBI, Eve, Kenshi Yonezu, Aimer, LiSA, amazarashi, Asian Kung-Fu Generation, BUMP OF CHICKEN, MAN WITH A MISSION, The Pillows, Ellegarden, Maximum the Hormone, My First Story, Tricot, Kana-Boon, Blue Encount, Sakanaction, FLOW, GRANRODEO, High and Mighty Color
   - Idol-adjacent acts even if they have visual elements: BABYMETAL, Band-MAID, LOVEBITES, Wagakki Band, Golden Bomber, Silent Siren, SCANDAL
   - J-pop artists, even if they have a VK background or roots (e.g. solo work by former VK members that is clearly pop)
   - K-pop, anime music, idol groups, Vocaloid
   - An artist whose CURRENT work is pop/mainstream, even if they once dressed in VK style
   - General music industry news (awards, streaming milestones) where a VK band is only mentioned in passing
   - Any article where Visual Kei is not the PRIMARY focus

   IMPORTANT: "Has VK roots" or "used to be in a VK band" does NOT make someone VK. Judge by their CURRENT music and image.
   DO NOT describe non-VK bands as Visual Kei in your write-up even if the source website covers VK.
   When in doubt, respond NOT_VK — this blog covers active Visual Kei only.`;

  const prompt = `You are the editor of VKNews (vknyusu.blogspot.com), an English-language Visual Kei music news blog for Western fans.

Article title: ${item.title}
Source: ${item.link}
${rawContent ? `Article body:\n${rawContent}` : '(No article body — work from the title only)'}

Instructions:
${vkCheckInstructions}

2. Write a full blog post for Western VK fans:
   - Translate all Japanese to English (keep band names, album/song titles in their original form)
   - 250–400 words
   - Opening line should hook the reader without restating the title verbatim
   - Add brief context about the band for fans who may not know them
   - Preserve all factual details: dates, venues, ticket prices, links
   - End with a call to action directing readers to the band's own channels (official site, ticket link, streaming, etc.) — written in YOUR voice
   - Tone: enthusiastic but editorial, not a press release copy-paste
   - Do NOT include YouTube embeds, iframes, or any raw HTML — write plain prose only
   - Do NOT name, reference, or link to the source website anywhere in the post (not vk.gy, barks.jp, jame-world, JRR, natalie.mu, tower.jp, aramajapan, or any other news site)
   - Do NOT include ANY of these: "let us know in the comments", "follow us", "subscribe", "share this article", "check [site] for updates", "support us on Patreon", or any other call-to-action that belongs to the original source — this blog does not have comments
   - Do NOT reproduce boilerplate PR phrases verbatim — rewrite in your own editorial voice
${extraImages.length > 0 ? `   - The following additional images are available from the source article. Insert them naturally in the article body using Markdown: ![descriptive alt text](url). Space them out — one per section, not all at the start. Use only images that are relevant to the surrounding text:
${extraImages.map((u, i) => `     ${i + 1}. ${u}`).join('\n')}` : ''}

3. Write an SEO-optimised post title:
   - Front-load the band name and the key news hook
   - Be specific, not vague (e.g. "Dir En Grey Announce 2026 Japan Tour Dates" not "A New Journey Begins")
   - 60 characters max

4. Suggest 3–6 blog labels (e.g. "News", "Live Report", "Album Release", band name, subgenre)

Respond in EXACTLY this format — no extra text before or after:
TITLE: [English post title]
LABELS: [comma-separated labels]
CONTENT:
[post body]`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();

  if (text.startsWith('NOT_VK')) return null;

  const titleMatch = text.match(/^TITLE:\s*(.+)/m);
  const labelsMatch = text.match(/^LABELS:\s*(.+)/m);
  const contentMatch = text.match(/^CONTENT:\n([\s\S]+)/m);

  if (!titleMatch || !contentMatch) {
    console.warn('  → Unexpected response format, skipping');
    return null;
  }

  return {
    title: titleMatch[1].trim(),
    labels: [...new Set(['Visual Kei', ...(labelsMatch ? labelsMatch[1].split(',').map(l => l.trim()) : ['News'])])],
    content: contentMatch[1].trim(),
  };
}


// Domains known to block external image requests even through proxy
const BLOCKED_IMAGE_DOMAINS = [
  'cdn.jrockone.com',
  'cdn.discoursecdn.com',  // Discourse forum CDN
  'pbs.twimg.com',         // Twitter CDN — blocks hotlinking
  'scontent.cdninstagram.com', // Instagram CDN — blocks hotlinking
  'scontent-*.cdninstagram.com',
];

function proxiedImageUrl(url) {
  if (!url) return null;
  if (BLOCKED_IMAGE_DOMAINS.some(d => url.includes(d))) return null;
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=800&output=jpg`;
}

async function fetchVKDBNewsItems() {
  const BASE = 'http://www.vkdb.jp';
  const CUTOFF_DAYS = 30;
  const cutoff = new Date(Date.now() - CUTOFF_DAYS * 86400_000);
  try {
    const res = await fetch(`${BASE}/NEWS.html`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VKNewsBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const seen = new Set();
    const items = [];
    $('a[href^="/NEWS_"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const link = `${BASE}${href}`;
      if (seen.has(link)) return;
      seen.add(link);
      const title = $(el).text().trim() || href;

      // Extract the date from surrounding text (format: YYYY/MM/DD or YYYY-MM-DD)
      const ctx = $(el).parent().text();
      const dateMatch = ctx.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
      if (!dateMatch) return; // no date found — skip rather than assume it's new
      const isoDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00.000Z`;
      if (new Date(isoDate) < cutoff) return; // older than 30 days — skip

      items.push({ title, link, guid: link, isoDate });
    });
    console.log(`→ ${items.length} items scraped from vkdb.jp/NEWS.html (within ${CUTOFF_DAYS} days)`);
    return items;
  } catch (err) {
    console.warn(`  → vkdb.jp scrape failed: ${err.message}`);
    return [];
  }
}

async function fetchVKDBBirthdays() {
  const BASE = 'http://www.vkdb.jp';
  try {
    const res = await fetch(`${BASE}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const html = new TextDecoder('euc-jp').decode(buf);
    const $ = cheerio.load(html);

    const items = [];
    // Birthday section: <h3>M/D が誕生日のアーティスト</h3> followed by <h4> member entries
    $('h4').each((_, h4el) => {
      const memberLink = $(h4el).find('a').first();
      if (!memberLink.length) return;

      // Raw member name may include Japanese reading in parens — take text before first (
      const rawName = memberLink.text().trim();
      const memberName = rawName.split('(')[0].trim();
      if (!memberName) return;

      // The <p> after the <h4> contains the band history as links separated by →
      // The LAST band link is their most recent band
      const p = $(h4el).next('p');
      if (!p.length) return;

      const bandLinks = p.find('a');
      if (!bandLinks.length) return;

      // Most recent band = last link; decode the band name
      const lastBand = bandLinks.last();
      const bandName = lastBand.text().trim();
      if (!bandName || bandName.includes('個人') || bandName.includes('不明')) return;

      // Only keep ASCII-readable band names (avoids posting about obscure Japanese-only names)
      if (!/^[\x20-\x7E]+$/.test(bandName)) return;

      const guid = `vkdb-birthday-${memberName}-${new Date().toISOString().slice(0, 10)}`;
      items.push({
        title: `${memberName} (${bandName}) Birthday`,
        link: `${BASE}${memberLink.attr('href') || '/'}`,
        guid,
        isoDate: new Date().toISOString(),
        _birthday: { memberName, bandName },
      });
    });

    console.log(`→ ${items.length} birthday items from vkdb.jp`);
    return items;
  } catch (err) {
    console.warn(`  → vkdb.jp birthday scrape failed: ${err.message}`);
    return [];
  }
}

async function fetchClubZyNewsItems() {
  const BASE = 'https://www.club-zy.com';
  const PAGES = 2;
  const seen = new Set();
  const items = [];

  try {
    for (let page = 1; page <= PAGES; page++) {
      const url = page === 1
        ? `${BASE}/contents/news`
        : `${BASE}/contents/news/page/${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VKNewsBot/1.0; +https://vkchronicle.com)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const $ = cheerio.load(html);

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        // Only numeric content pages like /contents/1071238
        if (!href || !/^\/contents\/\d+$/.test(href)) return;
        const link = `${BASE}${href}`;
        if (seen.has(link)) return;
        seen.add(link);

        const title = $(el).find('h3').text().trim() || $(el).text().trim();
        if (!title) return;

        // Skip their own magazine announcement articles
        if (/vijuttoke|dollttoke/i.test(title)) {
          console.log(`  → Skipping club-zy.com magazine article: ${title.slice(0, 60)}`);
          return;
        }

        // Parse date from <time datetime="YYYY-MM-DD"> inside the link
        const datetime = $(el).find('time').attr('datetime'); // "2026-05-08"
        const isoDate = datetime
          ? new Date(`${datetime}T00:00:00Z`).toISOString()
          : new Date().toISOString();

        items.push({ title, link, guid: link, isoDate });
      });
    }
    console.log(`→ ${items.length} items scraped from club-zy.com`);
    return items;
  } catch (err) {
    console.warn(`  → club-zy.com scrape failed: ${err.message}`);
    return [];
  }
}

async function pingGoogle() {
  try {
    await fetch(`https://www.google.com/ping?sitemap=${SITE_BASE_URL}/sitemap.xml`,
      { signal: AbortSignal.timeout(8000) });
    console.log('  → Google sitemap pinged');
  } catch {
    // Non-fatal
  }
}

async function publishToJekyll({ title, labels, content }, item, imageUrl, relatedReview = null, bandProfile = null, youtubeId = null, relatedPosts = []) {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  const filename = `${dateStr}-${slug}.md`;
  const filepath = path.join(SITE_REPO_PATH, '_posts', filename);
  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(5, 7);
  const postUrl = `${SITE_BASE_URL}/${year}/${month}/${slug}/`;

  const safeTitle = title.replace(/"/g, '\\"');
  const labelsYaml = `[${labels.map(l => `"${l.replace(/"/g, '\\"')}"`).join(', ')}]`;

  let frontMatter = `---\nlayout: post\ntitle: "${safeTitle}"\ndate: ${date.toISOString()}\nlabels: ${labelsYaml}\nsource: "${item.link}"\n`;
  if (imageUrl)      frontMatter += `image: "${proxiedImageUrl(imageUrl)}"\n`;
  if (youtubeId)     frontMatter += `youtube_id: "${youtubeId}"\n`;
  if (bandProfile)   frontMatter += `band_profile_url: "${bandProfile.url}"\nband_profile_name: "${bandProfile.name}"\n`;
  if (relatedReview) frontMatter += `related_review_url: "${relatedReview.url}"\nrelated_review_title: "${relatedReview.title?.replace(/"/g, '\\"')}"\n`;
  if (relatedPosts?.length) {
    frontMatter += `related_posts:\n${relatedPosts.map(p => `  - title: "${p.title?.replace(/"/g, '\\"')}"\n    url: "${p.url}"`).join('\n')}\n`;
  }
  frontMatter += `---\n\n`;

  writeFileSync(filepath, frontMatter + content + '\n');

  execSync(
    `git -C "${SITE_REPO_PATH}" add "_posts/${filename}" && git -C "${SITE_REPO_PATH}" commit -m "Post: ${safeTitle.slice(0, 60)}"`,
    { stdio: 'pipe' }
  );

  pushWithRebase();

  console.log(`  ✓ Published: "${title}"`);
  return postUrl;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const TEST_VKDB = process.argv.includes('--test-vkdb');
  const TEST_CLUBZY = process.argv.includes('--test-clubzy');

  // Validate env
  const required = ['ANTHROPIC_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Load posted history
  const posted = existsSync(POSTED_FILE)
    ? new Set(JSON.parse(readFileSync(POSTED_FILE, 'utf8')))
    : new Set();

  // Load recent titles for duplicate detection
  const recentTitles = loadRecentTitles();

  // Load reviewed albums for internal linking
  const reviewedAlbums = loadReviewedAlbums();

  // Load band profile URLs for internal linking
  const bandProfiles = loadBandProfilesLocal();
  console.log(`→ ${bandProfiles.size} band profiles loaded`);

  // Load recent posts for the related posts block
  const recentPosts = loadRecentPostsLocal();
  console.log(`→ ${recentPosts.length} recent posts loaded`);

  // Setup Anthropic
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Fetch RSS feeds directly (no bridge — fetch all in parallel)
  const RSS_FEEDS = [
    'https://barks.jp/feed/',
    'https://tower.jp/feeds/article/news',
    'https://feeds.feedburner.com/jpurecords',
    'https://www.jame-world.com/rss/jame-article-en.xml',
    'https://vk.gy/rss',
    'https://jrockrevolution.com/feed/',
    'https://jrocknews.com/feed',
    'https://natalie.mu/music/feed/news',
    // 'https://forum.jrockone.com/c/news.rss', // disabled — too much non-VK content slipping through
    'https://crimsonlotus.eu/feed/',
    'https://aramajapan.com/tag/visual-kei/feed/',
    'https://www.jpopgo.co.uk/feed/',
  ];

  let feed = { items: [] };
  if (!TEST_VKDB && !TEST_CLUBZY) {
    console.log(`Fetching ${RSS_FEEDS.length} RSS feeds...`);
    const parser = new Parser({ timeout: 15000 });
    const results = await Promise.allSettled(RSS_FEEDS.map(url => parser.parseURL(url)));
    let successCount = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        feed.items.push(...results[i].value.items);
        successCount++;
      } else {
        console.warn(`  ! Feed failed (${RSS_FEEDS[i].split('/')[2]}): ${results[i].reason?.message}`);
      }
    }
    console.log(`→ ${feed.items.length} total items from ${successCount}/${RSS_FEEDS.length} feeds`);
  }

  const vkdbItems = await fetchVKDBNewsItems();
  const clubZyItems = await fetchClubZyNewsItems();
  feed.items = [...feed.items, ...vkdbItems, ...clubZyItems];
  console.log(`→ ${feed.items.length} total items after adding vkdb.jp and club-zy.com`);

  // Filter: new items only, VK content only, not too old
  const cutoff = new Date(Date.now() - MAX_ITEM_AGE_DAYS * 24 * 60 * 60 * 1000);
  const candidates = feed.items.filter(item => {
    const id = itemId(item);
    if (!id) return false;
    if (TEST_VKDB) return item.link && item.link.includes('vkdb.jp');
    if (TEST_CLUBZY) return item.link && item.link.includes('club-zy.com');
    if (posted.has(id)) return false;
    if (!isVKContent(item)) return false;
    const pubDate = new Date(item.pubDate || item.isoDate || '');
    if (!isNaN(pubDate.getTime()) && pubDate < cutoff) {
      posted.add(id); // mark old items as seen so we don't recheck them
      return false;
    }
    return true;
  });
  console.log(`→ ${candidates.length} new VK candidates`);

  if (candidates.length === 0) {
    console.log('Nothing new to post.');
    return;
  }

  let postedCount = 0;
  const maxPosts = (TEST_VKDB || TEST_CLUBZY) ? 2 : MAX_POSTS_PER_RUN;

  for (const item of candidates) {
    if (postedCount >= maxPosts) {
      console.log(`Reached max posts per run (${maxPosts}). Stopping.`);
      break;
    }

    console.log(`\nProcessing: ${item.title}`);
    const id = itemId(item);

    // Get raw content and images — from feed first, then scrape if needed
    const feedHtml = item.content || item['content:encoded'] || '';
    let rawContent = feedHtml || item.contentSnippet || '';
    let imageUrls = extractImagesFromFeedContent(feedHtml);

    let youtubeId = extractYoutubeId(feedHtml);

    if (rawContent.length < 150 || imageUrls.length === 0 || !youtubeId) {
      console.log('  → Fetching source article...');
      const fetched = await fetchArticleContent(item.link);
      if (rawContent.length < 150 && fetched.text) rawContent = fetched.text;
      // vkdb.jp og:image is always the site icon — skip it, use artist lookup instead
      if (imageUrls.length === 0 && fetched.images?.length && !item.link.includes('vkdb.jp')) {
        imageUrls = fetched.images;
      }
      if (!youtubeId && fetched.youtubeId) youtubeId = fetched.youtubeId;
    }
    if (youtubeId) console.log(`  → YouTube video found: ${youtubeId}`);

    // Validate all candidate images through the proxy (GET check, not HEAD)
    const validImages = [];
    for (const url of imageUrls.slice(0, 6)) { // cap at 6 to avoid too many requests
      const ok = await isImageAccessible(url);
      if (ok) {
        validImages.push(url);
        console.log(`  → Image verified: ${url.slice(0, 80)}`);
      } else {
        console.log(`  → Image blocked/unreachable: ${url.slice(0, 80)}`);
      }
    }

    let imageUrl = validImages[0] || null;
    const extraImages = validImages.slice(1).map(proxiedImageUrl).filter(Boolean);

    // Enrich with Claude
    let enriched;
    try {
      enriched = await enrichWithClaude(anthropic, item, rawContent, isVKDedicatedSource(item.link), extraImages);
    } catch (err) {
      console.warn('  → Claude error:', err.message);
      posted.add(id); // skip it next time too
      continue;
    }

    if (!enriched) {
      console.log('  → Not VK content, skipping');
      posted.add(id);
      continue;
    }

    // Duplicate story check — same band + similar story already posted in last 48h?
    if (isDuplicateStory(enriched.title, recentTitles)) {
      console.log(`  → Duplicate story detected, skipping: "${enriched.title}"`);
      posted.add(id);
      continue;
    }

    // YouTube thumbnail — verified across quality levels, directly relevant to the post
    if (!imageUrl && youtubeId) {
      imageUrl = await fetchYoutubeThumbnail(youtubeId);
    }

    // vk.gy group photo — best source for VK band images; cached to band-images.json
    if (!imageUrl) {
      const artist = extractArtistFromTitle(enriched.title);
      if (artist) imageUrl = await fetchVkgyArtistImage(artist);
    }

    // Artist photo fallback — Last.fm → iTunes
    if (!imageUrl) {
      const artist = extractArtistFromTitle(enriched.title);
      if (artist) {
        console.log(`  → Trying Last.fm for "${artist}"...`);
        imageUrl = await fetchArtistPhoto(artist);
        if (imageUrl) {
          console.log(`  → Last.fm photo found`);
        } else {
          console.log(`  → Last.fm miss, trying iTunes...`);
          imageUrl = await fetchItunesArtistImage(artist);
          if (imageUrl) console.log(`  → iTunes artist photo found`);
        }
      }
    }

    // vkdb.jp-only: if still no image, canonicalize name via MusicBrainz (prefers
    // "visual kei" disambiguation) then retry Last.fm and iTunes with the clean name
    if (!imageUrl && item.link.includes('vkdb.jp')) {
      const rawArtist = extractArtistFromTitle(enriched.title);
      if (rawArtist) {
        console.log(`  → vkdb.jp item — trying MusicBrainz canonicalization for "${rawArtist}"...`);
        const canonical = await canonicalizeVKArtistName(rawArtist);
        if (canonical !== rawArtist) console.log(`  → Canonical name: "${canonical}"`);
        imageUrl = await fetchArtistPhoto(canonical);
        if (imageUrl) {
          console.log(`  → Last.fm photo found with canonical name`);
        } else {
          imageUrl = await fetchItunesArtistImage(canonical);
          if (imageUrl) console.log(`  → iTunes photo found with canonical name`);
        }
      }
    }

    // Final fallback — branded site placeholder, always guaranteed
    if (!imageUrl) {
      imageUrl = 'https://vkchronicle.com/assets/images/placeholder.jpg';
      console.log(`  → Using site placeholder image`);
    }

    // Check for related review to link internally
    const relatedReview = findRelatedReview(enriched.title, enriched.content, reviewedAlbums);
    if (relatedReview) console.log(`  → Related review found: "${relatedReview.title}"`);

    // Find matching band profile for internal linking
    const bandProfile = findBandProfile(enriched.title, enriched.content, bandProfiles);
    if (bandProfile) console.log(`  → Band profile found: "${bandProfile.name}"`);

    // Pick related posts (prefer same artist, fallback to recent)
    const relatedPostsForItem = findRelatedPosts(enriched.labels, recentPosts);

    // Publish to GitHub Pages
    try {
      const postUrl = await publishToJekyll(enriched, item, imageUrl, relatedReview, bandProfile, youtubeId, relatedPostsForItem);
      posted.add(id);
      postedCount++;
      recentTitles.push({ title: enriched.title, ts: Date.now() });
      saveRecentPost({ title: enriched.title, url: postUrl, published: new Date().toISOString(), labels: enriched.labels, image: imageUrl });
      // Save YouTube ID for monthly video roundup
      if (youtubeId) {
        const artist = extractArtistFromTitle(enriched.title);
        saveMonthlyVideo({ videoId: youtubeId, postTitle: enriched.title, postUrl, artist });
        console.log(`  → Video saved for monthly roundup`);
      }
    } catch (err) {
      console.error('  → Publish failed:', err.message);
      // Don't mark as posted — will retry next run
    }

    // Polite delay between posts
    if (postedCount < MAX_POSTS_PER_RUN) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Save updated history
  writeFileSync(POSTED_FILE, JSON.stringify([...posted], null, 2));
  saveRecentTitles(recentTitles);
  console.log(`\nDone. Posted ${postedCount} new item(s).`);

  if (postedCount > 0) {
    await pingGoogle();
    await sendTelegram(`🎸 <b>VKNews</b>: posted ${postedCount} new article${postedCount > 1 ? 's' : ''}.`);
  }

  await fetchAndSavePopularAndBirthdays();
}

main().catch(async err => {
  console.error('Fatal error:', err);
  await sendTelegram(`⚠️ <b>VKNews pipeline error:</b> ${err.message}`);
  process.exit(1);
});
