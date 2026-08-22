/**
 * create-band-recommendations.js
 *
 * "If you already love X / Y / Z, you'll love [VK band]"
 * Each VK band appears exactly once. Multiple Western reference points per card.
 * Band photos fetched from Last.fm.
 *
 * Usage:
 *   node create-band-recommendations.js
 *   node create-band-recommendations.js --dry-run
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
const PAGE_TITLE = 'If You Like... Visual Kei Band Recommendations';
const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

// ─── Data ─────────────────────────────────────────────────────────────────────
// Each card: one VK band, multiple Western reference points, one description.
// No VK band or Western artist repeats across cards.

const RECOMMENDATIONS = [
  {
    band: 'Dir en grey',
    lastfmSlug: 'Dir+en+grey',
    tags: ['extreme metal', 'progressive', 'avant-garde'],
    ifYouLike: ['Slipknot', 'Korn', 'Deftones'],
    description: 'The most intense band in VK\'s history — and one of the most intense in all of rock. Dir en grey started as theatrical glam-metal and spent 25 years evolving into something genuinely extreme. Kyo\'s vocal range from clean melody to guttural screaming mirrors Corey Taylor\'s approach; the progressive guitar structures and confrontational imagery will feel immediately familiar to Korn and Deftones fans. Start with Vulgar for the mid-era pivot, or Uroboros for full commitment.',
  },
  {
    band: 'The GazettE',
    lastfmSlug: 'the+GazettE',
    tags: ['heavy rock', 'melodic metal', 'arena scale'],
    ifYouLike: ['Avenged Sevenfold', 'Bullet for My Valentine', 'HIM'],
    description: 'The biggest VK band of their generation and one of the few to sell out arenas internationally. Aoi and Uruha\'s twin guitar work is genuinely world-class — clean melodic leads over crushing rhythm sections, exactly the template A7X and BFMV built their careers on. The GazettE\'s Division and Dogma albums are their heaviest; Dim and Stacked Rubbish have the same dark romanticism as HIM at their peak.',
  },
  {
    band: 'Buck-Tick',
    lastfmSlug: 'Buck-Tick',
    tags: ['post-punk', 'new wave', 'gothic'],
    ifYouLike: ['David Bowie', 'The Cure', 'New Order'],
    description: 'Japan\'s greatest art rock shapeshifters. Buck-Tick have been reinventing themselves since 1987 — post-punk, synthwave, gothic rock, cold wave — with the same restless intelligence Bowie brought to each era-shift. The Cure\'s atmospheric melancholy and New Order\'s electronic experimentation are both present. Aku no Hana and Taboo are the dark post-punk entries; Yumemiru Uchuu is their electronic phase.',
  },
  {
    band: 'X Japan',
    lastfmSlug: 'X+Japan',
    tags: ['power metal', 'glam', 'classical piano'],
    ifYouLike: ['Queen', 'Mötley Crüe', 'Bon Jovi'],
    description: 'The band that started it all. X Japan took Western glam metal and power ballads and pushed them to a theatrical extreme that Queen would have respected — Yoshiki\'s classical piano arrangements alongside shredding guitar, enormous anthems, and a visual presentation that made Mötley Crüe look understated. Rose of Pain and Art of Life are the landmarks; Weekend is the ballad that will destroy you.',
  },
  {
    band: 'LUNA SEA',
    lastfmSlug: 'LUNA+SEA',
    tags: ['alternative rock', 'art rock', 'cinematic'],
    ifYouLike: ['Radiohead', 'Smashing Pumpkins', 'Soundgarden'],
    description: 'The most musically sophisticated of the classic VK bands — cinematic, layered, and built on a dynamic range that goes from quiet introspection to full-force attack. Sugizo\'s guitar work has the same textural depth as Billy Corgan\'s; the band\'s ambition and refusal to repeat themselves recalls Radiohead\'s decade-spanning reinventions. Mother and Style are the essential albums.',
  },
  {
    band: 'Malice Mizer',
    lastfmSlug: 'Malice+Mizer',
    tags: ['gothic', 'baroque', 'orchestral'],
    ifYouLike: ['Evanescence', 'Within Temptation', 'Theatres des Vampires'],
    description: 'Baroque orchestration, gothic imagery, and Gackt\'s operatic vocals — Malice Mizer built the gothic-VK template that everything else followed. If you love Evanescence\'s drama and Within Temptation\'s cinematic scope, Merveilles (1998) will feel like finding a lost sibling. Strange, ornate, and completely unlike anything in Western rock.',
  },
  {
    band: 'Versailles',
    lastfmSlug: 'Versailles',
    tags: ['symphonic metal', 'neoclassical', 'power metal'],
    ifYouLike: ['Nightwish', 'DragonForce', 'Blind Guardian'],
    description: 'The gold standard for symphonic VK. Hizaki and Teru\'s twin guitar work operates at DragonForce speed with Blind Guardian\'s compositional depth, all framed by orchestral arrangements that rival Nightwish at their peak. Jubilee is the masterpiece. Kamijo\'s operatic baritone and the band\'s Versailles-era French aristocrat visual concept make them unlike anything else in the genre.',
  },
  {
    band: 'Plastic Tree',
    lastfmSlug: 'Plastic+Tree',
    tags: ['melancholic rock', 'indie', 'post-punk'],
    ifYouLike: ['Placebo', 'Bright Eyes', 'Death Cab for Cutie'],
    description: 'Beautiful and quietly devastating. Plastic Tree\'s music carries the same sense of resigned sadness as Placebo at their most introspective — guitar lines that feel like they\'re barely holding themselves together, vocals that sit with pain rather than dramatising it. Utsusemi is the masterpiece. For fans of confessional indie and post-punk melancholy who want something that doesn\'t shout.',
  },
  {
    band: 'MUCC',
    lastfmSlug: 'MUCC',
    tags: ['dark alternative', 'progressive', 'heavy'],
    ifYouLike: ['Tool', 'A Perfect Circle', 'Nine Inch Nails'],
    description: 'Heavy, dark, and deeply patient — MUCC reward listeners who want music that takes its time. The progressive dynamics of Tool, the emotional weight of A Perfect Circle, and the industrial textures of NIN are all present in different eras of their catalogue. Homura Uta is their gothic peak; Karma is the accessible entry point. One of the most consistently excellent bands in VK history.',
  },
  {
    band: 'Alice Nine',
    lastfmSlug: 'Alice+Nine',
    tags: ['melodic rock', 'emotional', 'accessible'],
    ifYouLike: ['My Chemical Romance', 'Panic! at the Disco', 'Taking Back Sunday'],
    description: 'Theatrical, emotionally resonant, and built on melodies that genuinely get under your skin. Alice Nine occupy the same dramatic rock space as Three Cheers-era MCR and A Fever You Can\'t Sweat Out — emotional intensity wrapped in accessible songwriting. Gemini is the essential album; Rainbows is one of the best singles in the genre. A perfect first VK band.',
  },
  {
    band: 'exist†trace',
    lastfmSlug: 'exist†trace',
    tags: ['female-fronted', 'heavy alt-rock', 'melodic metal'],
    ifYouLike: ['Paramore', 'Halestorm', 'The Pretty Reckless'],
    description: 'The benchmark for female-fronted VK. Jyou\'s vocals are powerful and controlled, the band\'s sound evolved from heavy metal to polished alt-rock over a decade, and they never lost the visual commitment that defines the genre. Fans of Paramore\'s later heavier direction and Halestorm\'s rock credentials will find a lot to love across their extensive catalogue.',
  },
  {
    band: 'lynch.',
    lastfmSlug: 'lynch.',
    tags: ['industrial rock', 'dark', 'precise'],
    ifYouLike: ['Rammstein', 'Marilyn Manson', 'Rob Zombie'],
    description: 'Industrial-influenced heavy rock delivered with surgical precision and a dark visual identity that matches Manson and Zombie\'s aesthetic commitment. Lynch. are less chaotic than Rammstein but equally deliberate — every riff is placed exactly where it needs to be. Sinners and Exodus are the entry points for fans coming from Western industrial metal.',
  },
  {
    band: 'Moi dix Mois',
    lastfmSlug: 'Moi+dix+Mois',
    tags: ['darkwave', 'gothic metal', 'cold'],
    ifYouLike: ['Type O Negative', 'Sisters of Mercy', 'Bauhaus'],
    description: 'Mana\'s post-Malice Mizer project stripped away the baroque excess and replaced it with darkwave precision. Cold, gothic, and obsessive about its aesthetic — the same relentless commitment to the dark side that defines Type O Negative and Sisters of Mercy. Dix Infernal is the starting point; the production is immaculate and the atmosphere genuinely unsettling.',
  },
  {
    band: 'Deviloof',
    lastfmSlug: 'Deviloof',
    tags: ['death metal', 'extreme', 'uncompromising'],
    ifYouLike: ['Whitechapel', 'Cannibal Corpse', 'Thy Art Is Murder'],
    description: 'The most extreme active VK band and proof that the visual aesthetic can coexist with genuine death metal brutality. Deviloof don\'t compromise on either front — Keisuke\'s vocals are terrifying, the guitar work is technically demanding, and the live shows are full-theatre productions. Debauchery is the entry point; not for the faint-hearted.',
  },
  {
    band: 'An Cafe',
    lastfmSlug: 'An+Cafe',
    tags: ['oshare-kei', 'pop-punk', 'colourful'],
    ifYouLike: ['Green Day', 'Sum 41', 'New Found Glory'],
    description: 'The kings of oshare-kei — the happy, colourful, relentlessly energetic end of VK. If you love the simple joy of a great pop-punk hook, An Cafe deliver it in abundance. Kakusei Heroism is the definitive record. Don\'t be put off by the bright costumes; the songwriting is sharp, the energy is genuine, and it\'s near-impossible not to smile.',
  },
  {
    band: 'Hanabie.',
    lastfmSlug: 'Hanabie',
    tags: ['metalcore', 'pop-punk', 'modern'],
    ifYouLike: ['Bring Me the Horizon', 'Bad Omens', 'Spiritbox'],
    description: 'The most exciting band in the current VK generation and the one most likely to bridge the gap to modern metalcore fans. Hanabie\'s sound sits exactly where Bring Me the Horizon\'s pop-metal and Spiritbox\'s heavy alt-rock intersect — hook-heavy, loud, and delivered with complete conviction. They\'ve built a significant international following very fast.',
  },
];

// ─── Image fetching ───────────────────────────────────────────────────────────

async function fetchBandPhoto(lastfmSlug) {
  try {
    const url = `https://www.last.fm/music/${lastfmSlug}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Try og:image first
    const og = $('meta[property="og:image"]').attr('content');
    if (og && og.startsWith('http') && !og.includes(LASTFM_PLACEHOLDER) && !og.includes('/meta/')) {
      return og;
    }

    // Try background-image on header
    for (const sel of ['.header-new-background-image', '.band-header-image img', '.artist-header-image img']) {
      const el = $(sel).first();
      const src = el.attr('src') || el.attr('content');
      if (src && src.startsWith('http') && !src.includes(LASTFM_PLACEHOLDER)) return src;
    }

    return null;
  } catch {
    return null;
  }
}

function proxied(url) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=120&h=120&fit=cover&output=jpg`;
}

// ─── Build HTML ───────────────────────────────────────────────────────────────

async function buildHtml() {
  console.log('  Fetching band photos...');
  const photos = {};
  await Promise.all(RECOMMENDATIONS.map(async r => {
    photos[r.band] = await fetchBandPhoto(r.lastfmSlug);
    process.stdout.write(photos[r.band] ? '.' : 'x');
  }));
  console.log(`\n  → ${Object.values(photos).filter(Boolean).length}/${RECOMMENDATIONS.length} photos found`);

  const cards = RECOMMENDATIONS.map(rec => {
    const photo = photos[rec.band];
    const photoHtml = photo
      ? `<img src="${proxied(photo)}" alt="${rec.band}" class="rec-photo" />`
      : `<div class="rec-initial">${rec.band.charAt(0)}</div>`;

    const tagPills = rec.tags.map(t => `<span class="rec-tag">${t}</span>`).join('');
    const ifPills  = rec.ifYouLike.map(a => `<span class="rec-if-pill">${a}</span>`).join('');

    return `<div class="rec-card">
  <div class="rec-band-header">
    <div class="rec-avatar">${photoHtml}</div>
    <div class="rec-band-meta">
      <h2 class="rec-band-name">${rec.band}</h2>
      <div class="rec-tags">${tagPills}</div>
    </div>
  </div>
  <div class="rec-body">
    <p class="rec-if-label">If you already love:</p>
    <div class="rec-if-pills">${ifPills}</div>
    <p class="rec-desc">${rec.description}</p>
  </div>
</div>`;
  }).join('\n\n');

  return `<div class="rec-page">

<p class="rec-intro">The best way into Visual Kei is through music you already love. Each card below spotlights one VK band and the Western artists whose fans tend to click with them immediately.</p>

${cards}

<div class="rec-footer">
  <h2>Want to Go Deeper?</h2>
  <p>Browse the <a href="/p/bands.html">Visual Kei Band Directory</a> for full profiles on every band listed here, or start at the <a href="/p/getting-into-visual-kei-where-to-start.html">Getting Into Visual Kei</a> guide if you want a more structured path in.</p>
</div>

</div>

<style>
.rec-page { max-width: 820px; margin: 0 auto; padding: 0 16px 48px; }
.rec-intro { font-size: 0.95rem; line-height: 1.7; color: rgba(255,255,255,0.6); margin-bottom: 28px; }
.rec-card { background: #111; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
.rec-band-header { display: flex; align-items: center; gap: 16px; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.rec-avatar { flex-shrink: 0; width: 64px; height: 64px; border-radius: 10px; overflow: hidden; background: #1a1a1a; display: flex; align-items: center; justify-content: center; }
.rec-photo { width: 64px; height: 64px; object-fit: cover; display: block; }
.rec-initial { font-size: 1.5rem; font-weight: 700; color: rgba(255,255,255,0.15); }
.rec-band-meta { flex: 1; min-width: 0; }
.rec-band-name { font-size: 1.2rem; font-weight: 700; color: #fff; margin: 0 0 6px; }
.rec-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.rec-tag { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; color: rgba(255,255,255,0.4); font-size: 0.67rem; letter-spacing: 0.05em; padding: 2px 8px; text-transform: uppercase; }
.rec-body { padding: 14px 20px 18px; }
.rec-if-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.3); margin: 0 0 8px; }
.rec-if-pills { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
.rec-if-pill { background: rgba(236,172,13,0.1); border: 1px solid rgba(236,172,13,0.3); border-radius: 20px; color: #ecac0d; font-size: 0.78rem; font-weight: 600; padding: 3px 10px; }
.rec-desc { font-size: 0.88rem; line-height: 1.65; color: rgba(255,255,255,0.6); margin: 0; }
.rec-footer { margin-top: 28px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.07); }
.rec-footer h2 { font-size: 1rem; font-weight: 700; color: #fff; margin-bottom: 6px; }
.rec-footer p { font-size: 0.88rem; line-height: 1.7; color: rgba(255,255,255,0.55); }
.rec-footer a { color: #ecac0d; text-decoration: underline; }
</style>`;
}

// ─── Publish ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Building "${PAGE_TITLE}"...`);
  const html = await buildHtml();

  if (DRY_RUN) {
    console.log('\n─────────────────────────────────────────────────────────');
    console.log(html.slice(0, 2000), '\n...[truncated]');
    return;
  }

  const existing = await blogger.pages.list({ blogId, status: 'live' });
  const match = (existing.data.items || []).find(p => p.title === PAGE_TITLE);

  if (match) {
    await blogger.pages.update({ blogId, pageId: match.id, requestBody: { title: PAGE_TITLE, content: html } });
    console.log(`  ✓ Updated: ${match.url}`);
  } else {
    const res = await blogger.pages.insert({ blogId, requestBody: { title: PAGE_TITLE, content: html } });
    console.log(`  ✓ Created: ${res.data.url}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
