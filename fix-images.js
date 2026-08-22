/**
 * fix-images.js - Fix broken/missing images in Blogger posts
 *
 * Strategy:
 *  1. Parse the original source URL already embedded in each post's footer
 *  2. Re-scrape that article for its og:image
 *  3. If found and accessible, update the post
 *
 * For the "broken on main page" issue: Blogger's CDN can't hotlink some external
 * images. This wraps those URLs in images.weserv.nl (free proxy) so Blogger's
 * thumbnail service can access them.
 *
 * Usage:
 *   node fix-images.js --list        List all posts + their current image status
 *   node fix-images.js --lastfm      Fix broken/missing images using Last.fm artist photos (recommended)
 *   node fix-images.js --fix         Re-scrape missing/wrong images from original source articles
 *   node fix-images.js --revert      Remove wrong images (the Wikipedia cities/flags ones)
 *   node fix-images.js --proxy-all   Wrap every existing post image in weserv.nl proxy (fixes hotlink/CDN issues)
 */

import 'dotenv/config';
import { google } from 'googleapis';
import * as cheerio from 'cheerio';

const args = process.argv.slice(2);
const mode = args.includes('--fix') ? 'fix'
           : args.includes('--revert') ? 'revert'
           : args.includes('--proxy-all') ? 'proxy-all'
           : args.includes('--lastfm') ? 'lastfm'
           : 'list';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

async function getAllPosts() {
  const posts = [];
  let pageToken;
  do {
    const res = await blogger.posts.list({ blogId, maxResults: 500, pageToken, status: 'live' });
    if (res.data.items) posts.push(...res.data.items);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return posts;
}

// Extract the source URL from the footer attribution link we add to every post
function extractSourceUrl(htmlContent) {
  if (!htmlContent) return null;
  const $ = cheerio.load(htmlContent);
  // Our formatHtml() puts: Source: <a href="...">
  const link = $('p a[href]').last();
  const href = link.attr('href');
  return href && href.startsWith('http') ? href : null;
}

// Extract the current header image from a post
function extractCurrentImage(htmlContent) {
  if (!htmlContent) return null;
  const $ = cheerio.load(htmlContent);
  return $('img').first().attr('src') || null;
}

// Check if a URL looks like a Wikipedia/Wikimedia image (the bad replacements)
function isWikipediaImage(url = '') {
  return url.includes('wikipedia.org') || url.includes('wikimedia.org');
}

// Wrap a URL in the weserv.nl proxy to bypass Blogger CDN hotlink issues
function proxiedUrl(url) {
  const encoded = encodeURIComponent(url);
  return `https://images.weserv.nl/?url=${encoded}&w=800&output=jpg`;
}

// Re-scrape the original article for an image
async function scrapeImageFromArticle(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VKNewsBot/1.0; +https://vknyusu.blogspot.com)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    let image = $('meta[property="og:image"]').attr('content') || null;
    if (!image) {
      const img = $('article img, main img, .entry-content img, .post-body img').first();
      const src = img.attr('src') || img.attr('data-src');
      if (src && src.startsWith('http')) image = src;
    }
    return image;
  } catch {
    return null;
  }
}

// Check if an image URL is actually reachable and returns image data
async function isImageAccessible(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    return ct.startsWith('image/') || ct.includes('jpeg') || ct.includes('png') || ct.includes('webp');
  } catch {
    return false;
  }
}

// Check if a URL actually works when proxied through weserv.nl
async function isAccessibleViaProxy(originalUrl) {
  if (!originalUrl) return false;
  const proxied = `https://images.weserv.nl/?url=${encodeURIComponent(originalUrl)}&w=400&output=jpg`;
  try {
    const res = await fetch(proxied, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const ct = res.headers.get('content-type') || '';
    return res.ok && ct.startsWith('image/');
  } catch { return false; }
}

async function fetchArtistPhoto(artistName) {
  if (!artistName) return null;
  try {
    const url = `https://www.last.fm/music/${encodeURIComponent(artistName)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const img = $('meta[property="og:image"]').attr('content');
    if (img && img.startsWith('http') && !img.includes('placeholder') && !img.includes('/meta/')) return img;
    return null;
  } catch { return null; }
}

function extractArtistFromTitle(title) {
  if (!title) return null;
  const m = title.match(/^(.+?)\s+(?:announces?|releases?|shares?|drops?|reveals?|unveils?|returns?|streams?|posts?|debuts?|tours?|performs?|launches?|previews?|teases?|honors?|marks?|celebrates?|signs?|joins?|leaves?|disbands?|reforms?|confirms?|wins?|scores?|hits?|collaborates?|covers?|reimagines?|revisits?|presents?)\b/i);
  if (m) return m[1].trim();
  return title.split(/\s+/).slice(0, 3).join(' ');
}

// Rebuild the post HTML with a new image (or without one if null)
function rebuildPostHtml(htmlContent, newImageUrl, postTitle) {
  const $ = cheerio.load(htmlContent);
  const existingImg = $('img').first().parent();

  // Remove old image container (the div we wrap images in)
  $('img').first().closest('div').remove();
  // Also try removing standalone img
  $('img').first().remove();

  const body = $('body').html() || htmlContent;

  if (!newImageUrl) return body;

  const imageDiv = `<div style="margin-bottom:1.5em;text-align:center;">
  <img src="${newImageUrl}" alt="${(postTitle || '').replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;border-radius:4px;" />
</div>`;

  return imageDiv + '\n' + body;
}

async function updatePost(post, newContent) {
  await blogger.posts.update({
    blogId,
    postId: post.id,
    requestBody: { title: post.title, content: newContent, labels: post.labels },
  });
}

async function main() {
  console.log('Fetching posts...');
  const posts = await getAllPosts();
  console.log(`Total posts: ${posts.length}\n`);

  if (mode === 'list') {
    console.log('Post image inventory:\n');
    for (const post of posts) {
      const img = extractCurrentImage(post.content || '');
      const src = extractSourceUrl(post.content || '');
      const flag = !img ? '[NO IMAGE]' : isWikipediaImage(img) ? '[WIKIPEDIA - WRONG]' : '[OK]';
      console.log(`${flag} "${post.title}"`);
      if (img) console.log(`       img: ${img.slice(0, 100)}`);
      if (src) console.log(`    source: ${src}`);
    }
    console.log('\nRun --revert to remove wrong Wikipedia images.');
    console.log('Run --fix to re-scrape original articles for real images.');
    return;
  }

  if (mode === 'revert') {
    // Remove Wikipedia images (wrong ones) — set posts back to no-image
    let fixed = 0;
    for (const post of posts) {
      const img = extractCurrentImage(post.content || '');
      if (!isWikipediaImage(img)) continue;
      console.log(`Removing wrong image from: "${post.title}"`);
      const newContent = rebuildPostHtml(post.content || '', null, post.title);
      try {
        await updatePost(post, newContent);
        console.log('  ✓ Reverted');
        fixed++;
      } catch (err) {
        console.error(`  ✗ Failed: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`\nReverted ${fixed} posts.`);
    return;
  }

  if (mode === 'fix') {
    // Re-scrape original articles for images
    let fixed = 0;
    let skipped = 0;

    for (const post of posts) {
      const currentImg = extractCurrentImage(post.content || '');
      const sourceUrl = extractSourceUrl(post.content || '');

      // Skip posts that already have a good image (not Wikipedia, not missing)
      if (currentImg && !isWikipediaImage(currentImg)) continue;

      console.log(`\nFixing: "${post.title}"`);
      if (!sourceUrl) {
        console.log('  ✗ No source URL found in post, skipping');
        skipped++;
        continue;
      }

      console.log(`  → Scraping: ${sourceUrl}`);
      let newImage = await scrapeImageFromArticle(sourceUrl);

      if (!newImage) {
        console.log('  ✗ No image found in source article');
        skipped++;
        continue;
      }

      // Wrap in proxy to avoid Blogger CDN hotlink issues on the main page
      newImage = proxiedUrl(newImage);
      console.log(`  → Image: ${newImage}`);

      const newContent = rebuildPostHtml(post.content || '', newImage, post.title);
      try {
        await updatePost(post, newContent);
        console.log('  ✓ Updated');
        fixed++;
      } catch (err) {
        console.error(`  ✗ Failed to update: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\nDone. Fixed: ${fixed}, Skipped: ${skipped}`);
  }

  if (mode === 'proxy-all') {
    // Wrap every existing image URL in weserv.nl proxy so Blogger's CDN can fetch them
    let updated = 0;
    let skipped = 0;

    for (const post of posts) {
      const currentImg = extractCurrentImage(post.content || '');
      if (!currentImg) { skipped++; continue; }

      // Already proxied — skip
      if (currentImg.includes('weserv.nl')) { skipped++; continue; }

      const newImage = proxiedUrl(currentImg);
      const newContent = rebuildPostHtml(post.content || '', newImage, post.title);

      console.log(`Proxying image in: "${post.title}"`);
      try {
        await updatePost(post, newContent);
        console.log('  ✓ Done');
        updated++;
      } catch (err) {
        console.error(`  ✗ Failed: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\nDone. Proxied: ${updated}, Skipped (no image or already proxied): ${skipped}`);
  }

  if (mode === 'lastfm') {
    // For every post: check if image is missing or broken via proxy, then fix with Last.fm photo
    let fixed = 0, alreadyOk = 0, noPhoto = 0;

    // Skip review posts and weekly digests — they handle their own images
    const targets = posts.filter(p =>
      !p.labels?.includes('Reviews') &&
      !p.labels?.includes('Album Review') &&
      !p.title?.toLowerCase().includes('this week in visual kei')
    );
    console.log(`Checking ${targets.length} news posts...\n`);

    for (const post of targets) {
      const $ = cheerio.load(post.content || '', { decodeEntities: false });
      const img = $('img').first();
      const hasImg = img.length > 0;
      const imgSrc = img.attr('src') || '';

      // Determine if image is broken or missing
      let needsFix = false;
      if (!hasImg) {
        needsFix = true;
        console.log(`[MISSING ] "${post.title}"`);
      } else {
        // Extract original URL from weserv proxy URL if present
        const urlMatch = imgSrc.match(/images\.weserv\.nl\/\?url=([^&]+)/);
        const originalUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : imgSrc;
        const ok = await isAccessibleViaProxy(originalUrl);
        if (!ok) {
          needsFix = true;
          console.log(`[BROKEN  ] "${post.title}"`);
        } else {
          process.stdout.write('.');
          alreadyOk++;
          continue;
        }
      }

      if (!needsFix) continue;

      const artist = extractArtistFromTitle(post.title);
      if (!artist) { console.log(`  → Can't extract artist name`); noPhoto++; continue; }

      const photoUrl = await fetchArtistPhoto(artist);
      if (!photoUrl) { console.log(`  → No Last.fm photo for "${artist}"`); noPhoto++; continue; }

      console.log(`  → Last.fm photo: ${photoUrl.slice(0, 70)}`);

      // Build new image HTML
      const imageHtml = `<div style="margin-bottom:1.5em;text-align:center;">\n  <img src="${proxiedUrl(photoUrl)}" alt="${post.title.replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;border-radius:4px;" />\n</div>`;

      let newContent;
      if (!hasImg) {
        // Inject after JSON-LD block, or prepend
        newContent = (post.content || '').includes('</script>')
          ? (post.content || '').replace('</script>', `</script>\n${imageHtml}`)
          : imageHtml + '\n' + (post.content || '');
      } else {
        // Replace the broken image's wrapper div
        $('img').first().closest('div').replaceWith(imageHtml);
        newContent = $('body').html() || (post.content || '');
      }

      try {
        await blogger.posts.update({
          blogId,
          postId: post.id,
          requestBody: { title: post.title, content: newContent, labels: post.labels },
        });
        console.log(`  ✓ Fixed`);
        fixed++;
      } catch (err) {
        console.error(`  ✗ ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`\n\nDone. Fixed: ${fixed} | Already OK: ${alreadyOk} | No photo found: ${noPhoto}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
