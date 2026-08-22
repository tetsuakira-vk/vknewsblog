/**
 * update-guide-images.js
 *
 * Injects a band photo grid into the Visual Kei guide pages:
 *   - "Visual Kei Explained: A Complete Guide"
 *   - "Getting Into Visual Kei: Where to Start"
 *
 * Also creates a "Start Here" navigation hub page linking all guides together.
 *
 * Usage: node update-guide-images.js [--dry-run]
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

const DRY_RUN = process.argv.includes('--dry-run');
const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

// ─── Band photos to feature on each page ─────────────────────────────────────

const EXPLAINED_BANDS = [
  { name: 'X Japan',        slug: 'X+Japan' },
  { name: 'Buck-Tick',      slug: 'Buck-Tick' },
  { name: 'Malice Mizer',   slug: 'Malice+Mizer' },
  { name: 'Dir en grey',    slug: 'Dir+en+grey' },
  { name: 'The GazettE',    slug: 'the+GazettE' },
  { name: 'Versailles',     slug: 'Versailles' },
];

const GETTING_IN_BANDS = [
  { name: 'Dir en grey',    slug: 'Dir+en+grey' },
  { name: 'Alice Nine',     slug: 'Alice+Nine' },
  { name: 'Versailles',     slug: 'Versailles' },
  { name: 'Plastic Tree',   slug: 'Plastic+Tree' },
  { name: 'An Cafe',        slug: 'An+Cafe' },
  { name: 'The GazettE',    slug: 'the+GazettE' },
];

// ─── Photo fetcher ────────────────────────────────────────────────────────────

async function fetchPhoto(slug) {
  try {
    const res = await fetch(`https://www.last.fm/music/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const og = $('meta[property="og:image"]').attr('content');
    if (og && og.startsWith('http') && !og.includes(LASTFM_PLACEHOLDER) && !og.includes('/meta/')) return og;
    return null;
  } catch { return null; }
}

function proxied(url, w = 300, h = 200) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${w}&h=${h}&fit=cover&output=jpg`;
}

// ─── Build photo grid HTML ────────────────────────────────────────────────────

function buildPhotoGrid(bands, photos, caption) {
  const items = bands.map(b => {
    const src = photos[b.slug];
    if (!src) return '';
    return `<div class="guide-grid-item">
  <img src="${proxied(src)}" alt="${b.name}" />
  <span>${b.name}</span>
</div>`;
  }).filter(Boolean).join('\n');

  if (!items) return '';

  return `<div class="guide-photo-grid">
${items}
</div>
${caption ? `<p class="guide-photo-caption">${caption}</p>` : ''}

<style>
.guide-photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 8px; border-radius: 12px; overflow: hidden; }
.guide-grid-item { position: relative; aspect-ratio: 3/2; overflow: hidden; }
.guide-grid-item img { width: 100%; height: 100%; object-fit: cover; display: block; filter: brightness(0.8); transition: filter 0.2s; }
.guide-grid-item:hover img { filter: brightness(1); }
.guide-grid-item span { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.75)); color: rgba(255,255,255,0.85); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; padding: 12px 8px 6px; text-transform: uppercase; }
.guide-photo-caption { font-size: 0.75rem; color: rgba(255,255,255,0.3); text-align: center; margin-bottom: 2em; font-style: italic; }
@media (max-width: 600px) { .guide-photo-grid { grid-template-columns: repeat(2, 1fr); } .guide-grid-item:last-child:nth-child(odd) { display: none; } }
</style>`;
}

// ─── Inject grid into existing page content ───────────────────────────────────

function injectGridIntoPage(existingContent, gridHtml) {
  // Remove any previously injected grid
  const cleaned = existingContent.replace(/<!-- GUIDE_GRID_START -->[\s\S]*?<!-- GUIDE_GRID_END -->/g, '');

  // Insert after the opening <div class="evergreen-page"> and <h1> title
  const marker = '<!-- GUIDE_GRID_START -->' + gridHtml + '<!-- GUIDE_GRID_END -->';

  // Find the closing </h1> of the page title and inject after it
  const titleEnd = cleaned.indexOf('</h1>');
  if (titleEnd === -1) return marker + cleaned;

  return cleaned.slice(0, titleEnd + 5) + '\n' + marker + '\n' + cleaned.slice(titleEnd + 5);
}

// ─── Start Here hub page ──────────────────────────────────────────────────────

function buildStartHerePage(guideUrls) {
  return `<div class="sh-page">

<p class="sh-intro">New to Visual Kei? You're in the right place. Start with any of the guides below — or jump straight into the news if you already know what you're looking for.</p>

<div class="sh-cards">

  <a href="${guideUrls.gettingInto}" class="sh-card sh-card--featured">
    <div class="sh-card-label">Start here</div>
    <h2>Getting Into Visual Kei</h2>
    <p>Gateway recommendations by taste, essential albums, where to listen, and answers to every question a newcomer asks. The best place to begin.</p>
    <span class="sh-card-cta">Read the guide →</span>
  </a>

  <a href="${guideUrls.explained}" class="sh-card">
    <div class="sh-card-label">Background</div>
    <h2>Visual Kei Explained</h2>
    <p>What is Visual Kei? Where did it come from? A complete history of the genre from its 1980s origins to the current international scene.</p>
    <span class="sh-card-cta">Read the guide →</span>
  </a>

  <a href="${guideUrls.recommendations}" class="sh-card">
    <div class="sh-card-label">Find your band</div>
    <h2>Band Recommendations</h2>
    <p>If you like Slipknot, Nightwish, Placebo, or Paramore — find the VK band you'll love. 16 entry points matched to Western artists you know.</p>
    <span class="sh-card-cta">Find your match →</span>
  </a>

  <a href="${guideUrls.bestAlbums}" class="sh-card">
    <div class="sh-card-label">Essential listening</div>
    <h2>Best VK Albums of All Time</h2>
    <p>Twenty landmark albums spanning 1989 to the present. The definitive starting collection for any new fan.</p>
    <span class="sh-card-cta">See the list →</span>
  </a>

  <a href="${guideUrls.bands}" class="sh-card">
    <div class="sh-card-label">Directory</div>
    <h2>Band Directory</h2>
    <p>Individual profiles for 70+ Visual Kei bands — photos, biographies, top tracks, and links to our coverage of each act.</p>
    <span class="sh-card-cta">Browse bands →</span>
  </a>

  <a href="/" class="sh-card">
    <div class="sh-card-label">Latest news</div>
    <h2>VK News Feed</h2>
    <p>Updated twice daily with the latest Visual Kei news, releases, and live announcements from Japan and beyond.</p>
    <span class="sh-card-cta">Read the news →</span>
  </a>

</div>

</div>

<style>
.sh-page { max-width: 820px; margin: 0 auto; padding: 0 16px 48px; }
.sh-intro { font-size: 0.95rem; line-height: 1.7; color: rgba(255,255,255,0.6); margin-bottom: 28px; }
.sh-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sh-card { display: block; background: #111; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 18px 20px; text-decoration: none; transition: border-color 0.2s, transform 0.15s; }
.sh-card:hover { border-color: rgba(236,172,13,0.3); transform: translateY(-2px); }
.sh-card--featured { grid-column: span 2; background: rgba(236,172,13,0.05); border-color: rgba(236,172,13,0.2); }
.sh-card-label { font-size: 0.67rem; letter-spacing: 0.1em; text-transform: uppercase; color: #ecac0d; margin-bottom: 6px; }
.sh-card h2 { font-size: 1.05rem; font-weight: 700; color: #fff; margin: 0 0 8px; }
.sh-card p { font-size: 0.85rem; line-height: 1.6; color: rgba(255,255,255,0.5); margin: 0 0 12px; }
.sh-card-cta { font-size: 0.8rem; font-weight: 600; color: #ecac0d; }
@media (max-width: 580px) { .sh-cards { grid-template-columns: 1fr; } .sh-card--featured { grid-column: span 1; } }
</style>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Fetch all photos in parallel
  console.log('Fetching band photos...');
  const allBands = [...new Map([...EXPLAINED_BANDS, ...GETTING_IN_BANDS].map(b => [b.slug, b])).values()];
  const photos = {};
  await Promise.all(allBands.map(async b => {
    photos[b.slug] = await fetchPhoto(b.slug);
    process.stdout.write(photos[b.slug] ? '.' : 'x');
  }));
  console.log(`\n→ ${Object.values(photos).filter(Boolean).length}/${allBands.length} photos found`);

  // Get existing pages
  const pagesRes = await blogger.pages.list({ blogId, status: 'live' });
  const existing = pagesRes.data.items || [];

  const findPage = title => existing.find(p => p.title === title);

  // ── 1. Visual Kei Explained ───────────────────────────────────────────────
  const explainedPage = findPage('Visual Kei Explained: A Complete Guide');
  if (explainedPage) {
    console.log('\nUpdating: Visual Kei Explained...');
    const grid = buildPhotoGrid(
      EXPLAINED_BANDS, photos,
      'Some of the artists that defined Visual Kei: X Japan, Buck-Tick, Malice Mizer, Dir en grey, The GazettE, Versailles'
    );
    const newContent = injectGridIntoPage(explainedPage.content, grid);
    if (DRY_RUN) {
      console.log(newContent.slice(0, 800), '...[truncated]');
    } else {
      await blogger.pages.update({ blogId, pageId: explainedPage.id, requestBody: { title: explainedPage.title, content: newContent } });
      console.log(`  ✓ Updated: ${explainedPage.url}`);
    }
  } else {
    console.log('  ! Visual Kei Explained page not found');
  }

  // ── 2. Getting Into Visual Kei ────────────────────────────────────────────
  const gettingInPage = findPage('Getting Into Visual Kei: Where to Start');
  if (gettingInPage) {
    console.log('\nUpdating: Getting Into Visual Kei...');
    const grid = buildPhotoGrid(
      GETTING_IN_BANDS, photos,
      'Six bands that represent what Visual Kei sounds and looks like across its range'
    );
    const newContent = injectGridIntoPage(gettingInPage.content, grid);
    if (DRY_RUN) {
      console.log(newContent.slice(0, 800), '...[truncated]');
    } else {
      await blogger.pages.update({ blogId, pageId: gettingInPage.id, requestBody: { title: gettingInPage.title, content: newContent } });
      console.log(`  ✓ Updated: ${gettingInPage.url}`);
    }
  } else {
    console.log('  ! Getting Into VK page not found');
  }

  // ── 3. Start Here hub page ────────────────────────────────────────────────
  console.log('\nBuilding: Start Here hub...');
  const guideUrls = {
    gettingInto:     gettingInPage?.url    || '/p/getting-into-visual-kei-where-to-start.html',
    explained:       explainedPage?.url    || '/p/visual-kei-explained-complete-guide.html',
    recommendations: existing.find(p => p.title.includes('If You Like'))?.url || '/p/if-you-like-visual-kei-band.html',
    bestAlbums:      existing.find(p => p.title.includes('Best Visual Kei'))?.url || '/p/best-visual-kei-albums-of-all-time.html',
    bands:           '/p/bands.html',
  };

  const startHereContent = buildStartHerePage(guideUrls);
  const existingStartHere = findPage('Start Here');

  if (DRY_RUN) {
    console.log(startHereContent.slice(0, 600), '...[truncated]');
    return;
  }

  if (existingStartHere) {
    await blogger.pages.update({ blogId, pageId: existingStartHere.id, requestBody: { title: 'Start Here', content: startHereContent } });
    console.log(`  ✓ Updated: ${existingStartHere.url}`);
  } else {
    const res = await blogger.pages.insert({ blogId, requestBody: { title: 'Start Here', content: startHereContent } });
    console.log(`  ✓ Created: ${res.data.url}`);
  }

  console.log('\nDone. Add "Start Here" to your Blogger navigation:');
  console.log('  Theme → Customize → Layout → Pages gadget → Edit → check "Start Here"');
}

main().catch(err => { console.error(err); process.exit(1); });
