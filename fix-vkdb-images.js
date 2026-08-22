/**
 * fix-vkdb-images.js
 * Finds Jekyll posts sourced from vkdb.jp whose image is still a site icon,
 * looks up a real artist photo via MusicBrainz (visual kei disambiguation) →
 * Last.fm → iTunes, and patches the front matter.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';
import { pushWithRebase } from './lib/jekyll.js';

const SITE_REPO_PATH = '/Users/robertnelson/vkchronicle';

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
    const vkMatch = artists.find(a =>
      a.score >= 60 && a.disambiguation?.toLowerCase().includes('visual kei')
    );
    if (vkMatch) return vkMatch.name;
    if (artists[0]?.score >= 80) return artists[0].name;
    return name;
  } catch {
    return name;
  }
}

async function fetchLastFmPhoto(artistName) {
  if (!artistName) return null;
  try {
    const res = await fetch(`https://www.last.fm/music/${encodeURIComponent(artistName)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const img = $('meta[property="og:image"]').attr('content');
    if (img && img.startsWith('http') && !img.includes('placeholder') && !img.includes('/meta/') && !img.includes('/avatar')) return img;
    return null;
  } catch {
    return null;
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
    return artist.artworkUrl100.replace('100x100bb', '600x600bb');
  } catch {
    return null;
  }
}

function extractArtistFromTitle(title) {
  if (!title) return null;
  const m = title.match(/^(.+?)\s+(?:announces?|releases?|shares?|drops?|reveals?|unveils?|returns?|streams?|posts?|debuts?|tours?|performs?|launches?|previews?|teases?|honors?|marks?|celebrates?|signs?|joins?|leaves?|disbands?|reforms?|confirms?|wins?|scores?|hits?|collaborates?|covers?|reimagines?|revisits?|presents?)\b/i);
  if (m) return m[1].trim();
  return title.split(/\s+/).slice(0, 3).join(' ');
}

function isSiteIcon(imageUrl) {
  // Detect known site icon patterns (vkdb logo, vk.gy card, weserv-proxied icons)
  if (!imageUrl) return true;
  const decoded = decodeURIComponent(imageUrl);
  return (
    decoded.includes('vkdb.jp/img/') ||
    decoded.includes('vk.gy/style/') ||
    decoded.includes('vk.gy/images/cards/')
  );
}

function proxiedImageUrl(url) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=800&output=jpg`;
}

async function main() {
  const postsDir = `${SITE_REPO_PATH}/_posts`;
  const files = readdirSync(postsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => `${postsDir}/${f}`);

  const vkdbPosts = files.filter(f => {
    const content = readFileSync(f, 'utf8');
    if (!content.includes('source: "http://www.vkdb.jp') && !content.includes("source: 'http://www.vkdb.jp")) return false;
    // Only fix posts that still have a site icon as their image
    const imgMatch = content.match(/^image:\s+"([^"]+)"/m);
    return imgMatch ? isSiteIcon(imgMatch[1]) : false;
  });

  if (vkdbPosts.length === 0) {
    console.log('No vkdb.jp posts with site-icon images found — nothing to fix.');
    return;
  }

  console.log(`Found ${vkdbPosts.length} vkdb.jp post(s) to fix:\n`);

  for (const filePath of vkdbPosts) {
    const raw = readFileSync(filePath, 'utf8');
    const titleMatch = raw.match(/^title:\s+"([^"]+)"/m) || raw.match(/^title:\s+'([^']+)'/m);
    const title = titleMatch?.[1] || '';
    console.log(`Processing: ${title}`);

    const rawArtist = extractArtistFromTitle(title);
    console.log(`  Raw artist: "${rawArtist}"`);

    // First pass — try directly with raw name
    let imageUrl = await fetchLastFmPhoto(rawArtist);
    if (imageUrl) {
      console.log(`  ✓ Last.fm found (raw name)`);
    } else {
      imageUrl = await fetchItunesArtistImage(rawArtist);
      if (imageUrl) console.log(`  ✓ iTunes found (raw name)`);
    }

    // Second pass — canonicalize via MusicBrainz, retry if different
    if (!imageUrl) {
      console.log(`  → Trying MusicBrainz canonicalization...`);
      const canonical = await canonicalizeVKArtistName(rawArtist);
      if (canonical && canonical !== rawArtist) {
        console.log(`  → Canonical name: "${canonical}"`);
        imageUrl = await fetchLastFmPhoto(canonical);
        if (imageUrl) {
          console.log(`  ✓ Last.fm found (canonical name)`);
        } else {
          imageUrl = await fetchItunesArtistImage(canonical);
          if (imageUrl) console.log(`  ✓ iTunes found (canonical name)`);
        }
      }
    }

    if (!imageUrl) {
      console.log(`  ✗ No artist photo found — skipping\n`);
      continue;
    }

    const proxied = proxiedImageUrl(imageUrl);
    const updated = raw.replace(/^image:\s+"[^"]*"(\r?\n)/m, `image: "${proxied}"$1`);

    if (updated === raw) {
      console.log(`  No image line to replace — skipping\n`);
      continue;
    }

    writeFileSync(filePath, updated, 'utf8');
    console.log(`  ✓ Image updated`);

    const filename = filePath.split('/').pop();
    try {
      execSync(
        `git -C "${SITE_REPO_PATH}" add "_posts/${filename}" && git -C "${SITE_REPO_PATH}" commit -m "Fix vkdb image: ${title.slice(0, 50)}"`,
        { stdio: 'pipe' }
      );
      pushWithRebase();
      console.log(`  ✓ Committed and pushed\n`);
    } catch (err) {
      console.error(`  ✗ Git error: ${err.stderr?.toString() || err.message}\n`);
    }
  }

  console.log('Done.');
}

main().catch(console.error);
