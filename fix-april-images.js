/**
 * fix-april-images.js - Add band photos to the 3 April news posts that had no album art
 * Fetches og:image from vk.gy artist pages, then patches the Blogger posts.
 * Run: node fix-april-images.js
 */

import 'dotenv/config';
import { google } from 'googleapis';
import * as cheerio from 'cheerio';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

// ─── Config ───────────────────────────────────────────────────────────────────

const TARGETS = [
  {
    artistSlug: 'DIAURA',
    titleFragment: 'INCOMPLETE',
  },
  {
    artistSlug: 'Dir+En+Grey',
    titleFragment: 'MORTAL DOWNER',
  },
  {
    artistSlug: 'Kizu',
    titleFragment: 'Gokuraku',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchBandPhoto(lastfmSlug) {
  // Last.fm artist pages have clean press photos (no watermarks)
  const url = `https://www.last.fm/music/${encodeURIComponent(lastfmSlug)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log(`  → Last.fm returned ${res.status} for ${lastfmSlug}`);
      return null;
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    // og:image is a large clean artist photo
    const img = $('meta[property="og:image"]').attr('content');
    if (img && img.startsWith('http') && !img.includes('placeholder') && !img.includes('default')) return img;

    return null;
  } catch (err) {
    console.log(`  → Failed to fetch Last.fm/${lastfmSlug}: ${err.message}`);
    return null;
  }
}

function proxied(url) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=800&output=jpg`;
}

function injectImage(htmlContent, imageUrl, altText) {
  const imageHtml = `<div style="margin-bottom:1.5em;text-align:center;">
  <img src="${proxied(imageUrl)}" alt="${altText}"
       style="max-width:100%;height:auto;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.3);" />
</div>\n`;

  // Insert after the closing </script> JSON-LD block if present, otherwise prepend
  if (htmlContent.includes('</script>')) {
    return htmlContent.replace('</script>', `</script>\n${imageHtml}`);
  }
  return imageHtml + htmlContent;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Fetch recent posts to find the targets
  console.log('Fetching recent posts...');
  const res = await blogger.posts.list({
    blogId,
    maxResults: 20,
    status: 'live',
    orderBy: 'published',
  });
  const posts = res.data.items || [];
  console.log(`Found ${posts.length} recent posts.`);

  for (const target of TARGETS) {
    console.log(`\nLooking for post matching: "${target.titleFragment}"`);

    const post = posts.find(p =>
      p.title.toLowerCase().includes(target.titleFragment.toLowerCase())
    );

    if (!post) {
      console.log(`  ✗ Post not found — may need to increase maxResults`);
      continue;
    }

    console.log(`  → Found: "${post.title}"`);

    // Strip any existing image block (the weserv-proxied vk.gy one)
    let baseContent = post.content;
    if (baseContent.includes('images.weserv.nl')) {
      baseContent = baseContent.replace(/<div[^>]*>\s*<img[^>]*images\.weserv\.nl[^>]*>[\s\S]*?<\/div>\n?/i, '');
      console.log(`  → Stripped old watermarked image`);
    }

    // Fetch band photo from vk.gy
    console.log(`  → Fetching band photo from vk.gy/${target.artistSlug}/`);
    const photoUrl = await fetchBandPhoto(target.artistSlug);

    if (!photoUrl) {
      console.log(`  ✗ No photo found for ${target.artistSlug}`);
      continue;
    }

    console.log(`  → Photo: ${photoUrl}`);

    // Patch the post
    const newContent = injectImage(baseContent, photoUrl, post.title);

    try {
      await blogger.posts.update({
        blogId,
        postId: post.id,
        requestBody: {
          title: post.title,
          content: newContent,
          labels: post.labels,
        },
      });
      console.log(`  ✓ Updated: "${post.title}"`);
    } catch (err) {
      console.error(`  ✗ Blogger error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
