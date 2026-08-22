/**
 * enrich-band.js
 * Enriches band profile pages with sourced bios and structured discography.
 *
 * Sources (fetched in parallel):
 *   - Wikipedia  — intro extract for factual foundation
 *   - Last.fm    — bio, members, location, years active (page scrape, no API key)
 *   - MusicBrainz — full discography (albums + EPs) via free API
 *
 * Writes to _bands/{slug}.md:
 *   - File body → Claude-synthesised 350-450 word editorial bio
 *   - Front matter: formed, origin, discography[]
 *
 * Usage:
 *   node enrich-band.js dir-en-grey        # single band
 *   node enrich-band.js --all              # all bands (with delay)
 */

import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';

const BANDS_DIR     = '/Users/robertnelson/vkchronicle/_bands';
const SLUG_MAP_FILE = 'band-slugs.json';
const DELAY_MS      = 2000; // polite delay between bands when running --all

const HEADERS_BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};
const HEADERS_MB = { 'User-Agent': 'VKChronicle/1.0 (vkchronicle.com)' };

// ─── Slug map ─────────────────────────────────────────────────────────────────

function loadSlugMap() {
  if (!existsSync(SLUG_MAP_FILE)) return {};
  try { const { _comment, ...s } = JSON.parse(readFileSync(SLUG_MAP_FILE, 'utf8')); return s; }
  catch { return {}; }
}

// ─── Front matter helpers ─────────────────────────────────────────────────────

function parseFrontMatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { fm: '', body: raw };
  return { fm: m[1], body: m[2] };
}

function getFmField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

function setFmField(fm, key, value) {
  const line = `${key}: ${JSON.stringify(value)}`;
  if (new RegExp(`^${key}:`, 'm').test(fm)) return fm.replace(new RegExp(`^${key}:.*$`, 'm'), line);
  return fm + `\n${line}`;
}

function setFmMultiline(fm, key, yamlBlock) {
  const fullEntry = `${key}:\n${yamlBlock}`;
  const lines = fm.split('\n');
  const startIdx = lines.findIndex(l => l.match(new RegExp(`^${key}:\\s*$`)));
  if (startIdx === -1) return fm + `\n${fullEntry}`;
  // Find the next top-level key (unindented line starting with a word char)
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\w/.test(lines[i])) { endIdx = i; break; }
  }
  return [
    ...lines.slice(0, startIdx),
    ...fullEntry.split('\n'),
    ...lines.slice(endIdx),
  ].join('\n');
}

function reassemble(fm, body) {
  return `---\n${fm.trimEnd()}\n---\n${body}`;
}

// ─── Wikipedia ────────────────────────────────────────────────────────────────

async function fetchWikipedia(bandName) {
  // REST summary API handles case and redirects automatically.
  // Try plain name first, then "(band)" disambiguation.
  const titleCase = bandName.charAt(0).toUpperCase() + bandName.slice(1).toLowerCase();
  const attempts = [
    bandName.replace(/ /g, '_'),
    bandName.replace(/ /g, '_') + '_(band)',
    bandName.replace(/ /g, '_') + '_(musician)',
    titleCase.replace(/ /g, '_') + '_(musician)',
    titleCase.replace(/ /g, '_') + '_(band)',
  ];
  for (const title of attempts) {
    try {
      const res = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        { headers: HEADERS_MB, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      // Skip disambiguation pages
      if (data.type === 'disambiguation') continue;
      // Skip articles clearly about non-music entities
      const desc = (data.description || '').toLowerCase();
      const NON_BAND_DESC = ['painter', 'sculptor', 'prophet', 'islamic', 'religious figure',
        'historical figure', 'fictional', 'antibiotic', 'drug compound', 'chemical compound',
        'comic character', 'television character', 'film character',
        'muhammad', 'daughter of', 'son of', 'bint ', 'ibn ', 'mathematician',
        'philosopher', 'politician', 'deity', 'goddess', 'god of'];
      if (NON_BAND_DESC.some(kw => desc.includes(kw))) continue;
      const text = data.extract?.trim();
      const rawThumb = data.thumbnail?.source || null;
      // Skip GIF and SVG-source thumbnails (maps, diagrams, logos)
      const thumb = rawThumb && !rawThumb.match(/\.gif[/?]|\.svg[/?]/i) ? rawThumb : null;
      if (text && text.length > 80) return { text, thumbnail: thumb };
    } catch { continue; }
  }
  return null;
}

// ─── Last.fm ──────────────────────────────────────────────────────────────────

const VK_PAGE_INDICATORS = ['visual kei', 'visual-kei', 'nagoya', 'japan', 'japanese'];

function pageMatchesVkBand(location, bio) {
  // Require Japan in location, OR VK keywords in the actual bio text.
  // Deliberately exclude raw — sidebar/related-artist text causes false positives.
  const locOk  = location && /japan/i.test(location);
  const bioOk  = bio && VK_PAGE_INDICATORS.some(kw => bio.toLowerCase().includes(kw));
  return locOk || bioOk;
}

async function fetchLastfmPage(slug) {
  try {
    const res = await fetch(`https://www.last.fm/music/${encodeURIComponent(slug)}`, {
      headers: HEADERS_BROWSER, signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    let location = null, yearsActive = null;
    $('dt').each((_, el) => {
      const label = $(el).text().trim();
      const value = $(el).next('dd').text().trim();
      if (/founded in/i.test(label))   location    = value || null;
      if (/years active/i.test(label)) yearsActive = value || null;
    });

    let bio = null;
    const wikiText = $('.wiki-content').first().text().trim();
    if (wikiText.length > 50) bio = wikiText;

    const wikiIdx = html.indexOf('wiki-row');
    const raw = wikiIdx !== -1
      ? html.slice(wikiIdx, wikiIdx + 8000)
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, 3000)
      : null;

    return { location, yearsActive, bio, raw };
  } catch { return null; }
}

async function searchLastfmCandidates(bandName) {
  try {
    const res = await fetch(
      `https://www.last.fm/search?q=${encodeURIComponent(bandName)}&type=artist`,
      { headers: HEADERS_BROWSER, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text());
    const slugs = [];
    $('a[href^="/music/"]').each((_, el) => {
      const m = $(el).attr('href').match(/^\/music\/([^/]+)$/);
      if (m && !slugs.includes(m[1])) slugs.push(m[1]);
    });
    return slugs.slice(0, 8);
  } catch { return []; }
}

async function fetchLastfm(lastfmSlug, bandName) {
  const triedSlugs = new Set();

  // Try the configured slug first
  if (lastfmSlug) {
    triedSlugs.add(lastfmSlug);
    const result = await fetchLastfmPage(lastfmSlug);
    if (result && pageMatchesVkBand(result.location, result.bio)) return result;
    if (result) console.log(`    Last.fm: "${lastfmSlug}" found but doesn't look like VK band, searching...`);
  }

  // Search for alternative slugs and find one that matches a VK/Japanese band.
  // Only accept slugs where the normalized slug starts with the normalized band name
  // (prevents false positives like "For Tracy Hyde" matching search for "HYDE").
  const normName = (bandName || lastfmSlug).toLowerCase().replace(/[^a-z0-9]/g, '');
  const slugRelevant = slug => {
    const normSlug = decodeURIComponent(slug).toLowerCase().replace(/[^a-z0-9]/g, '');
    return normName.length >= 3 && (normSlug.startsWith(normName) || normName.startsWith(normSlug));
  };

  const candidates = await searchLastfmCandidates(bandName || lastfmSlug);
  for (const slug of candidates) {
    if (triedSlugs.has(slug)) continue;
    if (!slugRelevant(slug)) continue;
    triedSlugs.add(slug);
    const result = await fetchLastfmPage(slug);
    if (result && pageMatchesVkBand(result.location, result.bio)) {
      console.log(`    Last.fm: found VK match at slug "${slug}"`);
      return result;
    }
  }

  return null;
}

// ─── MusicBrainz ─────────────────────────────────────────────────────────────

function mbNameMatches(searchName, mbName) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const a = norm(searchName);
  const b = norm(mbName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Token overlap: require ≥80% of search tokens present in MB name
  const aToks = a.split(/\s+/).filter(t => t.length > 1);
  const bToks = new Set(b.split(/\s+/));
  if (aToks.length === 0) return false;
  return aToks.filter(t => bToks.has(t)).length / aToks.length >= 0.8;
}

async function mbSearch(query) {
  const res = await fetch(
    `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query)}&limit=10&fmt=json`,
    { headers: HEADERS_MB, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return [];
  return (await res.json()).artists || [];
}

async function fetchMusicBrainzDiscography(bandName) {
  try {
    // Step 1: find artist MBID — try Japan-scoped search first to avoid
    // same-name collisions with Western bands (e.g. "Alice Nine").
    let artist = null;
    let jpMatch = false;

    // Japan-scoped search: boost JP artists then strictly post-filter to
    // country=JP + real artist types (excludes "Various Artists", "[unknown]" etc.)
    const jpResults = await mbSearch(`artist:${bandName} AND country:JP`);
    artist = jpResults.find(a =>
      a.score >= 75 &&
      a.country === 'JP' &&
      (a.type === 'Group' || a.type === 'Person')
    );
    if (artist) jpMatch = true;

    if (!artist) {
      // Fallback: unscoped — strict name match AND reject artists with an
      // explicit non-JP country (prevents matching Western bands/labels that
      // share a romanized name with a VK act).
      const allResults = await mbSearch(`artist:${bandName}`);
      artist = allResults.find(a =>
        a.score >= 85 &&
        mbNameMatches(bandName, a.name) &&
        (!a.country || a.country === 'JP') &&
        (a.type === 'Group' || a.type === 'Person')
      );
    }

    if (!artist) {
      console.log(`    MusicBrainz: no confident match for "${bandName}"`);
      return { releases: [], confident: false };
    }
    const mbid = artist.id;

    // Step 2: fetch release groups
    await new Promise(r => setTimeout(r, 1000)); // MB rate limit
    const releaseRes = await fetch(
      `https://musicbrainz.org/ws/2/release-group/?artist=${mbid}&type=album|ep&limit=100&fmt=json`,
      { headers: HEADERS_MB, signal: AbortSignal.timeout(10000) }
    );
    if (!releaseRes.ok) return { releases: [], confident: false };
    const releaseData = await releaseRes.json();

    const releases = (releaseData['release-groups'] || [])
      .filter(g => g['first-release-date'] && g['primary-type'])
      .map(g => ({
        title: g.title,
        type: g['primary-type'].toLowerCase(),
        year: g['first-release-date'].slice(0, 4),
        mbid: g.id,
      }))
      .sort((a, b) => a.year.localeCompare(b.year));

    return { releases, confident: jpMatch };
  } catch { return { releases: [], confident: false }; }
}

// ─── Claude bio synthesis ─────────────────────────────────────────────────────

async function synthesiseBio(anthropic, bandName, { wikipedia, lastfm, discography, existingTags, status }) {
  const albumList = discography
    .filter(d => d.type === 'album')
    .map(d => `${d.year}: ${d.title}`)
    .join(', ');

  const prompt = `You are writing the band profile page for ${bandName} on VKChronicle.com, an English-language Visual Kei resource for Western fans.

Write a 350–450 word editorial bio. Requirements:
- Open with something SPECIFIC to this band (their sound, a defining moment, what makes them distinct) — NOT a generic "they emerged from the VK scene" opener
- Name the members and their roles early if known
- Mention formation year and city/region
- Describe the musical evolution across their career with reference to specific albums
- Include their cultural significance within VK and Japanese rock broadly
- Close with their current status and why they still matter
- Tone: authoritative but enthusiastic, written for fans who may be discovering them

Do NOT include: headers, markdown formatting, source attributions, or filler phrases like "In conclusion" or "Overall".
Output the bio text ONLY — no title, no labels, just the paragraphs.

Source material (use freely, rewrite in your own editorial voice):

${wikipedia?.text ? `WIKIPEDIA:\n${wikipedia.text}\n\n` : ''}${lastfm?.raw ? `LAST.FM INFO:\n${lastfm.raw}\n\n` : ''}${albumList ? `DISCOGRAPHY (albums):\n${albumList}\n\n` : ''}GENRE TAGS: ${existingTags?.join(', ') || 'visual kei'}
STATUS: ${status || 'unknown'}`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text.trim();
}

// ─── Discography YAML ─────────────────────────────────────────────────────────

function formatDiscographyYaml(releases) {
  return releases
    .filter(r => r.type === 'album' || r.type === 'ep')
    .map(r => {
      let entry = `  - title: ${JSON.stringify(r.title)}\n    type: "${r.type}"\n    year: ${r.year}`;
      if (r.mbid) entry += `\n    mbid: "${r.mbid}"`;
      return entry;
    })
    .join('\n');
}

// ─── Main per-band logic ──────────────────────────────────────────────────────

async function enrichBand(anthropic, file, slugMap) {
  const fileSlug = file.replace('.md', '');
  const filePath = `${BANDS_DIR}/${file}`;
  const raw = readFileSync(filePath, 'utf8');
  const { fm, body } = parseFrontMatter(raw);

  const bandName   = getFmField(fm, 'name') || fileSlug;
  const lastfmSlug = getFmField(fm, 'lastfm_slug') || bandName.replace(/ /g, '+');
  const tags       = (fm.match(/^tags:\s*(\[.+\])/m)?.[1] || '').replace(/[\[\]"]/g, '').split(',').map(t => t.trim()).filter(Boolean);
  const status     = getFmField(fm, 'status');

  console.log(`\n── ${bandName} ──`);

  // Fetch all sources in parallel
  const [wikipedia, lastfm, mbResult] = await Promise.all([
    fetchWikipedia(bandName).then(r => { console.log(`  Wikipedia: ${r ? `${r.text.length} chars${r.thumbnail ? ', thumbnail' : ''}` : 'not found'}`); return r; }),
    fetchLastfm(lastfmSlug, bandName).then(r => { console.log(`  Last.fm: ${r ? 'found' : 'not found'}`); return r; }),
    fetchMusicBrainzDiscography(bandName).then(r => { console.log(`  MusicBrainz: ${r.releases.length} releases${r.confident ? '' : ' (fallback)'}`); return r; }),
  ]);

  const { releases: discography, confident: mbConfident } = mbResult;
  const hasSource = wikipedia?.text || lastfm?.raw;

  // Update front matter
  let newFm = fm;
  if (wikipedia?.thumbnail) newFm = setFmField(newFm, 'wiki_photo', wikipedia.thumbnail);
  if (lastfm?.location && /japan/i.test(lastfm.location)) newFm = setFmField(newFm, 'origin', lastfm.location);
  if (lastfm?.yearsActive && lastfm?.location && /japan/i.test(lastfm.location)) {
    const formedYear = lastfm.yearsActive.match(/(\d{4})/)?.[1];
    if (formedYear) newFm = setFmField(newFm, 'formed', formedYear);
  }

  // Only write discography if we can verify it's the right band:
  // confident = Japan-scoped search matched, or fallback match cross-validated by bio source
  const discYaml = formatDiscographyYaml(discography);
  if (discYaml && (mbConfident || hasSource)) newFm = setFmMultiline(newFm, 'discography', discYaml);

  if (!hasSource) {
    // No bio sources — keep existing body, just update front matter
    const result = reassemble(newFm, body);
    writeFileSync(filePath, result, 'utf8');
    console.log(`  ⚠ No sources found — front matter updated, existing bio kept (${discography.length} discography entries)`);
    return;
  }

  // Synthesise bio with Claude
  console.log(`  Claude: synthesising bio...`);
  const bio = await synthesiseBio(anthropic, bandName, { wikipedia, lastfm, discography, existingTags: tags, status });

  const result = reassemble(newFm, '\n' + bio + '\n');
  writeFileSync(filePath, result, 'utf8');
  console.log(`  ✓ Written (${bio.length} char bio, ${discography.length} discography entries)`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const slugMap   = loadSlugMap();
  const arg       = process.argv[2];

  if (!arg) {
    console.error('Usage: node enrich-band.js <slug>  OR  node enrich-band.js --all');
    process.exit(1);
  }

  if (arg === '--all') {
    const files = readdirSync(BANDS_DIR).filter(f => f.endsWith('.md')).sort();
    for (const file of files) {
      await enrichBand(anthropic, file, slugMap);
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  } else {
    const file = arg.endsWith('.md') ? arg : `${arg}.md`;
    if (!existsSync(`${BANDS_DIR}/${file}`)) {
      console.error(`Band file not found: ${BANDS_DIR}/${file}`);
      process.exit(1);
    }
    await enrichBand(anthropic, file, slugMap);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
