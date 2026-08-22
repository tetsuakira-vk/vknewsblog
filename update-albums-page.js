/**
 * update-albums-page.js
 *
 * Rebuilds the "Best Visual Kei Albums of All Time" page with album cover images
 * fetched from Last.fm. Writes best-vk-albums/index.html to the Jekyll repo.
 *
 * Usage: node update-albums-page.js [--dry-run]
 * Cron (monthly, 1st Sunday 11am): 0 11 1-7 * 0 cd /Users/robertnelson/vknewsblog && /usr/local/bin/node update-albums-page.js >> /tmp/vknews.log 2>&1
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { updateJekyllPage } from './lib/jekyll.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_TITLE = 'Best Visual Kei Albums of All Time';
const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

// ─── Album list ───────────────────────────────────────────────────────────────

const ALBUMS = [
  {
    artist: 'X Japan', album: 'Blue Blood', year: 1989,
    lastfmArtist: 'X+Japan', lastfmAlbum: 'Blue+Blood',
    description: 'The foundational statement that invented the Visual Kei template. X Japan fused classical piano arrangements with power metal guitar and outrageous glam aesthetics — nothing before it sounded like this, and the entire genre that followed owes Blue Blood a debt it can never repay.',
  },
  {
    artist: 'Buck-Tick', album: 'Aku no Hana', year: 1990,
    lastfmArtist: 'Buck-Tick', lastfmAlbum: 'Aku+no+Hana',
    description: 'Where X Japan went for spectacle, Buck-Tick went for atmosphere. Aku no Hana is dense with post-punk tension and new wave elegance — proof that Visual Kei was always more than just big hair and power chords. It still sounds unsettling and fresh.',
  },
  {
    artist: 'Malice Mizer', album: 'Merveilles', year: 1998,
    lastfmArtist: 'Malice+Mizer', lastfmAlbum: 'Merveilles',
    description: 'Baroque orchestration, gothic imagery, Gackt\'s operatic vocals — Merveilles is the record that proved VK could be genuinely cinematic. Mana\'s compositions reach for Versailles-level grandeur a decade before Versailles existed. One of the most original albums in Japanese rock history.',
  },
  {
    artist: 'Dir en grey', album: 'Vulgar', year: 2003,
    lastfmArtist: 'Dir+en+grey', lastfmAlbum: 'Vulgar',
    description: 'The pivot. Dir en grey left pop-metal behind and emerged with something genuinely confrontational — progressive structures, industrial textures, and Kyo\'s voice pushed to extremes. Vulgar is where the band stopped being a VK band and started being one of Japan\'s most important rock acts.',
  },
  {
    artist: 'MUCC', album: 'Homura Uta', year: 2003,
    lastfmArtist: 'MUCC', lastfmAlbum: 'Homura+Uta',
    description: 'Dense, gothic, and emotionally devastating. Homura Uta remains MUCC\'s defining statement — a record that balances crushing heaviness with deeply felt melody. The standard against which all dramatic VK is measured.',
  },
  {
    artist: 'Plastic Tree', album: 'Utsusemi', year: 2003,
    lastfmArtist: 'Plastic+Tree', lastfmAlbum: 'Utsusemi',
    description: 'If The Cure had come from Nagoya rather than Crawley. Utsusemi is melancholic guitar rock at its most refined — Ryutaro Arimura\'s vocals float above delicate, introspective arrangements that never overstay their welcome. Required listening for the sensitive end of VK.',
  },
  {
    artist: 'The GazettE', album: 'Stacked Rubbish', year: 2007,
    lastfmArtist: 'the+GazettE', lastfmAlbum: 'Stacked+Rubbish',
    description: 'The commercial and artistic peak of mid-era GazettE — where heavy riffs, immaculate production, and genuine songwriting craft converged. Reila alone justifies this album\'s presence on any best-of list. The record that made them one of the biggest bands in Japan.',
  },
  {
    artist: 'An Cafe', album: 'Kakusei Heroism', year: 2007,
    lastfmArtist: 'An+Cafe', lastfmAlbum: 'Kakusei+Heroism+%7E+THE+HERO+WITHOUT+A+NAME+%7E',
    description: 'The definitive oshare-kei record — colourful, unrelentingly upbeat, and built on pop-punk hooks that burrow deep. Kakusei Heroism is proof that Visual Kei\'s happy end could be just as addictive as its dark end. Essential for understanding the breadth of the genre.',
  },
  {
    artist: 'Alice Nine', album: 'Gemini', year: 2008,
    lastfmArtist: 'Alice+Nine', lastfmAlbum: 'Gemini',
    description: 'Melodic rock elevated by exceptional guitar work from Hiroto and Tora. Gemini is accessible enough to serve as a gateway to VK and accomplished enough to reward repeated listening. Rainbows in particular is one of the finest singles the genre has produced.',
  },
  {
    artist: 'Nightmare', album: 'Libido', year: 2004,
    lastfmArtist: 'Nightmare', lastfmAlbum: 'Libido',
    description: 'Libido established Nightmare as one of the genre\'s most reliable acts — hook-forward rock with a darker edge than most of their contemporaries and production that held up far better than most 2004 releases. The foundation of a long and consistent career.',
  },
  {
    artist: 'Versailles', album: 'Jubilee', year: 2010,
    lastfmArtist: 'Versailles', lastfmAlbum: 'Jubilee',
    description: 'The symphonic VK masterclass. Jubilee is Kamijo, Hizaki, and Teru at their most technically accomplished — baroque arrangements, soaring twin guitars, and an operatic ambition that few bands in any genre could match. Released following the death of bassist Jasmine You, it carries real emotional weight.',
  },
  {
    artist: 'SID', album: 'M&W', year: 2010,
    lastfmArtist: 'SID', lastfmAlbum: 'M%26W',
    description: 'The most commercially successful VK-adjacent band of their era, and M&W captures why — Mao\'s voice, Shinji\'s guitar textures, and production that balanced accessibility with genuine craft. A document of VK transitioning toward mainstream J-rock without losing its character.',
  },
  {
    artist: 'exist†trace', album: 'Spiral Daisakusen', year: 2012,
    lastfmArtist: 'exist%E2%80%A0trace', lastfmAlbum: 'Spiral+Daisakusen',
    description: 'The benchmark for female-fronted VK. exist†trace built their reputation on heavy, controlled aggression, and Spiral Daisakusen is their argument that gender norms in VK — already complicated — were irrelevant to what they were doing musically.',
  },
  {
    artist: 'Moi dix Mois', album: 'Dix Infernal', year: 2004,
    lastfmArtist: 'Moi+dix+Mois', lastfmAlbum: 'Dix+Infernal',
    description: 'Mana\'s post-Malice Mizer project stripped away the baroque excess and replaced it with darkwave precision. Dix Infernal is cold, gothic, and completely obsessive — the most aesthetically pure record in the genre and the gold standard for goth-VK.',
  },
  {
    artist: 'D', album: 'Genetic World', year: 2007,
    lastfmArtist: 'D', lastfmAlbum: 'Genetic+World',
    description: 'Theatrical, ornate, and built on a love of European gothic fantasy that gives it a character entirely its own. Asagi\'s storytelling and the band\'s commitment to their visual concept make Genetic World one of VK\'s most immersive concept albums.',
  },
  {
    artist: 'MEJIBRAY', album: 'Raven', year: 2015,
    lastfmArtist: 'Mejibray', lastfmAlbum: 'Raven',
    description: 'MEJIBRAY\'s output was uneven but Raven distilled their ambition into something focused and heavy. Where earlier releases felt scattered, this album locked into a direction — dark, aggressive, and with Tsuzuku\'s polarising vocal performances finally finding the right context.',
  },
  {
    artist: 'Girugamesh', album: 'Go', year: 2011,
    lastfmArtist: 'Girugamesh', lastfmAlbum: 'Go',
    description: 'Girugamesh at their most ambitious — progressive structures, heavy riffing, and Satoshi\'s voice pushing into genuinely uncomfortable territory. Go bridged VK and Western metalcore before the genre had really named what it was doing, and it still holds up.',
  },
  {
    artist: 'Deviloof', album: 'Debauchery', year: 2018,
    lastfmArtist: 'Deviloof', lastfmAlbum: 'Debauchery',
    description: 'The most extreme record on this list and proof that the VK aesthetic can coexist with genuine death metal brutality. Debauchery doesn\'t compromise on either front — Keisuke\'s vocals are terrifying, the guitars are crushing, and the visual presentation is full VK theatre.',
  },
  {
    artist: 'KIZU', album: 'Kasou', year: 2019,
    lastfmArtist: 'KIZU', lastfmAlbum: 'Kasou',
    description: 'Kasou announced KIZU as one of the most exciting bands in the current VK generation — heavy, emotionally raw, and built on a sound that owes as much to Western post-hardcore as it does to traditional VK. The future of the genre sounds like this.',
  },
  {
    artist: 'the god and death stars', album: 'Revolver', year: 2020,
    lastfmArtist: 'the+god+and+death+stars', lastfmAlbum: 'Revolver',
    description: 'A recent landmark from one of VK\'s most respected active bands. Revolver showcases the mature end of the genre — experienced musicianship, genuine songwriting, and a sound that doesn\'t need to chase trends because it\'s confident in what it already is.',
  },
];

// ─── Fetch album art from Last.fm ─────────────────────────────────────────────

async function fetchAlbumArt(lastfmArtist, lastfmAlbum) {
  try {
    const url = `https://www.last.fm/music/${lastfmArtist}/_/${lastfmAlbum}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    const og = $('meta[property="og:image"]').attr('content');
    if (og && og.startsWith('http') && !og.includes(LASTFM_PLACEHOLDER) && !og.includes('/meta/')) {
      return og;
    }
    return null;
  } catch {
    return null;
  }
}

function proxied(url, size = 200) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${size}&h=${size}&fit=cover&output=jpg`;
}

// ─── Build page HTML ──────────────────────────────────────────────────────────

async function buildHtml() {
  console.log('  Fetching album covers...');

  const covers = {};
  for (let i = 0; i < ALBUMS.length; i += 5) {
    const batch = ALBUMS.slice(i, i + 5);
    await Promise.all(batch.map(async a => {
      const art = await fetchAlbumArt(a.lastfmArtist, a.lastfmAlbum);
      covers[`${a.artist}/${a.album}`] = art;
      process.stdout.write(art ? '.' : 'x');
    }));
    if (i + 5 < ALBUMS.length) await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\n  → ${Object.values(covers).filter(Boolean).length}/${ALBUMS.length} covers found`);

  const items = ALBUMS.map((a, i) => {
    const cover = covers[`${a.artist}/${a.album}`];
    const coverHtml = cover
      ? `<img src="${proxied(cover)}" alt="${a.artist} – ${a.album}" class="alb-cover" />`
      : `<div class="alb-cover alb-cover-placeholder"><span>${a.year}</span></div>`;

    return `<div class="alb-item">
  <div class="alb-num">${i + 1}</div>
  ${coverHtml}
  <div class="alb-info">
    <h3 class="alb-title">${a.artist} <span class="alb-dash">—</span> <em>${a.album}</em></h3>
    <span class="alb-year">${a.year}</span>
    <p class="alb-desc">${a.description}</p>
  </div>
</div>`;
  }).join('\n\n');

  return `<div class="alb-page">

<p class="alb-intro">Twenty landmark albums spanning the full breadth of Visual Kei — from the genre's origins in 1989 through to the current generation. Whether you're discovering VK for the first time or filling gaps in a deep collection, these are the records that define the movement.</p>

<div class="alb-list">
${items}
</div>

<div class="alb-footer">
  <h2>Keep Up With New Releases</h2>
  <p>This list covers the classics — for what's coming out now, check our <a href="/releases/">New Releases</a> page, updated weekly from CDJapan. Current VK news is on the <a href="/">homepage</a>.</p>
</div>

</div>

<style>
.alb-page { max-width: 820px; margin: 0 auto; padding: 0 16px 48px; }
.alb-intro { font-size: 0.95rem; line-height: 1.7; color: rgba(255,255,255,0.65); margin-bottom: 32px; }
.alb-list { display: flex; flex-direction: column; gap: 16px; }
.alb-item { display: flex; align-items: flex-start; gap: 16px; background: #111; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 16px; }
.alb-num { flex-shrink: 0; width: 28px; font-size: 1.2rem; font-weight: 700; color: rgba(255,255,255,0.15); text-align: right; padding-top: 2px; }
.alb-cover { flex-shrink: 0; width: 80px; height: 80px; border-radius: 6px; object-fit: cover; background: #1a1a1a; display: block; }
.alb-cover-placeholder { flex-shrink: 0; width: 80px; height: 80px; border-radius: 6px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; }
.alb-cover-placeholder span { font-size: 0.75rem; color: rgba(255,255,255,0.2); }
.alb-info { flex: 1; min-width: 0; }
.alb-title { font-size: 0.95rem; font-weight: 700; color: #fff; margin: 0 0 4px; line-height: 1.3; }
.alb-title em { font-style: italic; color: rgba(255,255,255,0.8); }
.alb-dash { color: rgba(255,255,255,0.25); }
.alb-year { display: inline-block; font-size: 0.72rem; color: #ecac0d; letter-spacing: 0.05em; margin-bottom: 6px; }
.alb-desc { font-size: 0.85rem; line-height: 1.6; color: rgba(255,255,255,0.55); margin: 0; }
.alb-footer { margin-top: 32px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.07); }
.alb-footer h2 { font-size: 1.1rem; font-weight: 700; color: #fff; margin-bottom: 8px; }
.alb-footer p { font-size: 0.9rem; line-height: 1.7; color: rgba(255,255,255,0.6); }
.alb-footer a { color: #ecac0d; text-decoration: underline; }
</style>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Building "${PAGE_TITLE}"...`);
  const html = await buildHtml();

  if (DRY_RUN) {
    console.log('\n─────────────────────────────────────────────────────────');
    console.log(html.slice(0, 1500), '\n...[truncated]');
    return;
  }

  updateJekyllPage(
    'best-vk-albums/index.html',
    { layout: 'default', title: PAGE_TITLE, permalink: '/best-vk-albums/' },
    html,
    'Update best albums page',
  );
  console.log('✓ Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
