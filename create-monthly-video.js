/**
 * create-monthly-video.js
 *
 * Downloads 30-second clips from VK music videos, burns in the artist name
 * as a text overlay, crossfades between clips, and uploads to YouTube.
 *
 * Three-pass approach (proven to work):
 *   1. normalise   — consistent 720p / 30fps / H.264
 *   2. title       — burn artist text onto each clip individually
 *   3. xfade       — crossfade all titled clips into one output
 *
 * Usage:
 *   node create-monthly-video.js                        # previous month
 *   node create-monthly-video.js --month 2026-05        # specific month
 *   node create-monthly-video.js --videos ID1,ID2,ID3   # test with any YouTube IDs
 *   node create-monthly-video.js --videos ID1,ID2 --debug
 */

import 'dotenv/config';
import { execSync, execFileSync } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync,
  mkdirSync, rmSync, readdirSync, createReadStream, statSync,
} from 'fs';
import { google } from 'googleapis';
import path from 'path';
import { pushWithRebase } from './lib/jekyll.js';

const YTDLP        = '/Library/Frameworks/Python.framework/Versions/3.13/bin/yt-dlp';
const FFMPEG       = '/usr/local/bin/ffmpeg';
const FFPROBE      = '/usr/local/bin/ffprobe';
const MONTHLY_FILE = './monthly-videos.json';
const SITE_REPO    = '/Users/robertnelson/vkchronicle';
const WORK_DIR     = '/tmp/vk-monthly-video';

const CLIP_START  = 30;   // seconds into each video to begin (skip intros)
const CLIP_DUR    = 30;   // target clip length in seconds
const TEXT_DUR    = 5;    // seconds to show artist name overlay
const TRANS_DUR   = 1.0;  // crossfade duration between clips
const TARGET_W    = 1280;
const TARGET_H    = 720;
// Arial Unicode has full CJK glyph support; fall back to plain Arial
const FONT = [
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
].find(existsSync) ?? '';

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, debug = false) {
  execSync(cmd, { stdio: debug ? 'inherit' : 'pipe', timeout: 300_000 });
}

function argValue(flag) {
  const eq = process.argv.find(a => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--'))
    return process.argv[idx + 1];
  return null;
}

function getClipDuration(filePath) {
  try {
    const out = execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    return parseFloat(out.trim()) || CLIP_DUR;
  } catch {
    return CLIP_DUR;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function getYouTubeClient() {
  const auth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth });
}

// ── Pass 1: Download ──────────────────────────────────────────────────────────

function downloadClip(videoId, destBase, debug) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const section = `*${CLIP_START}-${CLIP_START + CLIP_DUR}`;
  try {
    execSync(
      `"${YTDLP}" --download-sections "${section}" ` +
      `-f "bv[height<=720]+ba/b[height<=720]/bv+ba/b" ` +
      `--ffmpeg-location /usr/local/bin ` +
      `-o "${destBase}.%(ext)s" "${url}"`,
      { stdio: debug ? 'inherit' : 'pipe', timeout: 120_000 },
    );
  } catch (err) {
    if (debug) console.error(err.stderr?.toString());
    return null;
  }
  const dir  = path.dirname(destBase);
  const stem = path.basename(destBase);
  const found = readdirSync(dir).find(f => f.startsWith(stem) && !f.endsWith('.part'));
  return found ? path.join(dir, found) : null;
}

// ── Pass 2a: Normalise ────────────────────────────────────────────────────────

function normalizeClip(inPath, outPath, debug) {
  run(
    `"${FFMPEG}" -y -i "${inPath}" ` +
    `-vf "scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TARGET_W}:${TARGET_H}:-1:-1:color=black,setsar=1,fps=30,setpts=PTS-STARTPTS" ` +
    `-af "asetpts=PTS-STARTPTS" ` +
    `-c:v libx264 -preset fast -crf 22 ` +
    `-c:a aac -ar 44100 -ac 2 -t ${CLIP_DUR} ` +
    `-movflags +faststart "${outPath}"`,
    debug,
  );
}

// ── Pass 2b: Burn title overlay ─────────────────────────────────────────────

function addTitle(inPath, outPath, artist, debug) {
  // execFileSync passes args as an array \u2014 no shell, no escaping needed at OS level.
  // Only need to handle ffmpeg's own filter parser: replace ' with curly apostrophe
  // so it does not close the ffmpeg single-quoted text value.
  const safe = String(artist).replace(/'/g, '\u2019');
  const fontPart = existsSync(FONT) ? `fontfile=${FONT}:` : '';
  const vf =
    `drawtext=${fontPart}text='${safe}':fontsize=40:fontcolor=white:` +
    `x=(w-text_w)/2:y=h*0.82:` +
    `shadowcolor=black:shadowx=3:shadowy=3:` +
    `box=1:boxcolor=black@0.5:boxborderw=20:` +
    `enable='between(t,0,${TEXT_DUR})'`;

  if (debug) console.log(`  vf: ${vf}`);

  execFileSync(FFMPEG, [
    '-y', '-i', inPath,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'copy',
    outPath,
  ], { stdio: debug ? 'inherit' : 'pipe', timeout: 300_000 });
}

// ── Pass 3: Crossfade concatenation ───────────────────────────────────────────

function stitchWithXfade(titledPaths, outputPath, debug) {
  if (titledPaths.length === 1) {
    run(`"${FFMPEG}" -y -i "${titledPaths[0]}" -c copy "${outputPath}"`, debug);
    return;
  }

  // Get actual durations so offsets are accurate even if clips vary slightly
  const durations = titledPaths.map(getClipDuration);
  console.log('  Clips to stitch:');
  titledPaths.forEach((p, i) =>
    console.log(`    [${i}] ${path.basename(p)}  ${durations[i].toFixed(2)}s  ${(statSync(p).size / 1024).toFixed(0)} KB`),
  );

  const inputs = titledPaths.map(p => `-i "${p}"`).join(' ');
  const lines  = [];

  // Normalise pixel format + ensure CFR before xfade (xfade requires constant frame rate)
  for (let i = 0; i < titledPaths.length; i++) {
    lines.push(`[${i}:v]fps=${30},format=yuv420p[v${i}]`);
    lines.push(`[${i}:a]anull[a${i}]`);
  }

  // Video: chain xfade — offset = cumulative sum of (dur - trans) for previous clips
  let offset = 0;
  let vprev  = 'v0';
  for (let i = 1; i < titledPaths.length; i++) {
    offset += durations[i - 1] - TRANS_DUR;
    const vout = i === titledPaths.length - 1 ? 'vout' : `xv${i}`;
    lines.push(`[${vprev}][v${i}]xfade=transition=fade:duration=${TRANS_DUR}:offset=${offset.toFixed(3)}[${vout}]`);
    vprev = vout;
  }

  // Audio: chain acrossfade
  let aprev = 'a0';
  for (let i = 1; i < titledPaths.length; i++) {
    const aout = i === titledPaths.length - 1 ? 'aout' : `xa${i}`;
    lines.push(`[${aprev}][a${i}]acrossfade=d=${TRANS_DUR}:c1=tri:c2=tri[${aout}]`);
    aprev = aout;
  }

  const filterFile = path.join(WORK_DIR, 'xfade.txt');
  writeFileSync(filterFile, lines.join(';\n'));
  console.log('  Filter script:');
  lines.forEach(l => console.log('    ' + l));

  run(
    `"${FFMPEG}" -y ${inputs} ` +
    `-filter_complex_script "${filterFile}" ` +
    `-map "[vout]" -map "[aout]" ` +
    `-c:v libx264 -preset fast -crf 22 -c:a aac -movflags +faststart "${outputPath}"`,
    debug,
  );
}

// ── YouTube upload ────────────────────────────────────────────────────────────

async function uploadToYouTube(youtube, filePath, title, description) {
  const size = statSync(filePath).size;
  console.log(`  → Uploading ${(size / 1024 / 1024).toFixed(1)} MB...`);
  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title, description,
          tags: ['visual kei', 'vk', 'j-rock', 'music video', 'monthly roundup'],
          categoryId: '10',
        },
        status: { privacyStatus: 'public' },
      },
      media: { mimeType: 'video/mp4', body: createReadStream(filePath) },
    },
    {
      onUploadProgress: evt => {
        const pct = Math.min(100, Math.round((evt.bytesRead / size) * 100));
        process.stdout.write(`\r  → Upload: ${pct}%   `);
      },
    },
  );
  process.stdout.write('\n');
  return res.data.id;
}

// ── Title cleaner ─────────────────────────────────────────────────────────────

function cleanVideoTitle(raw) {
  let t = raw.trim();

  // Strip bracketed noise: (Official MV), [Music Video], 【MV】, etc.
  const bracketed = [
    /\s*[\[(（【]\s*official\s*(?:music\s*)?(?:video|mv|clip|audio)\s*[\]）)】]/gi,
    /\s*[\[(（【]\s*(?:music\s*video|mv|pv)\s*[\]）)】]/gi,
    /\s*[\[(（【]\s*(?:short|full|live|teaser|trailer)\s*(?:ver(?:sion)?)?\.?\s*[\]）)】]/gi,
    /\s*[\[(（【]\s*official\s*[\]）)】]/gi,
    /\s*[\[(（【]\s*lyric(?:s|\s*video)?\s*[\]）)】]/gi,
  ];
  for (const re of bracketed) t = t.replace(re, '');

  // Strip trailing unbracketed noise — repeat until stable so stripping
  // "from album X" can then expose "Official MV" for a second pass
  const trailing = [
    /\s*from\s+(?:the\s+)?(?:album|single)\b.*/gi,
    /\s*[-–—]\s*official\s*(?:music\s*)?(?:video|mv|clip)\s*[-–—]?\s*$/gi,
    /\s*[-–—]\s*(?:music\s*video|mv|pv)\s*[-–—]?\s*$/gi,
    /\s*[-–—]\s*(?:short|full)\s*ver\.?\s*[-–—]?\s*$/gi,
    /\s*official\s*(?:music\s*)?(?:video|mv)\s*[-–—]?\s*$/gi,
  ];
  let prev;
  do {
    prev = t;
    for (const re of trailing) t = t.replace(re, '');
    t = t.replace(/\s*[-–—:]\s*$/, '').trim();
  } while (t !== prev);

  // Normalise "Artist / 「Song」" separator to "Artist - 「Song」"
  t = t.replace(/\s+\/\s+/, ' - ');

  t = t.replace(/\s+/g, ' ').trim();

  // Hard cap for the overlay — 52 chars fits comfortably at 40px on 1280px
  if (t.length > 52) t = t.slice(0, 49) + '...';

  return t;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const DEBUG = process.argv.includes('--debug');

  const monthArg = argValue('--month');
  let targetMonth;
  if (monthArg) {
    targetMonth = monthArg;
  } else {
    const d = new Date(); d.setDate(0);
    targetMonth = d.toISOString().slice(0, 7);
  }
  const [year] = targetMonth.split('-');
  const monthName = new Date(`${targetMonth}-15`).toLocaleString('en-US', { month: 'long' });
  console.log(`\nBuilding monthly video for: ${monthName} ${year}`);

  const videosArg = argValue('--videos');
  let videos;
  if (videosArg) {
    const ids = videosArg.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`Fetching titles for ${ids.length} video(s)...`);
    const yt = getYouTubeClient();
    const res = await yt.videos.list({ part: ['snippet'], id: ids });
    const titleMap = Object.fromEntries(res.data.items.map(v => [v.id, v.snippet.title]));
    videos = ids.map(id => ({ videoId: id, artist: cleanVideoTitle(titleMap[id] || id) }));
    videos.forEach(v => console.log(`  ${v.videoId} → ${v.artist}`));
  } else {
    const all = existsSync(MONTHLY_FILE) ? JSON.parse(readFileSync(MONTHLY_FILE, 'utf8')) : [];
    videos = all.filter(v => v.addedAt?.startsWith(targetMonth) && v.videoId);
  }

  if (videos.length === 0) {
    console.log(`No videos for ${targetMonth}. Use --videos ID1,ID2,ID3 to test.`);
    return;
  }
  console.log(`Found ${videos.length} video(s).\n`);

  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const titledPaths  = [];
  const titledArtists = [];

  for (const v of videos) {
    const artist   = v.artist || 'VK Artist';
    const rawBase  = path.join(WORK_DIR, `raw_${v.videoId}`);
    const normPath = path.join(WORK_DIR, `norm_${v.videoId}.mp4`);
    const titPath  = path.join(WORK_DIR, `tit_${v.videoId}.mp4`);

    console.log(`\n[${v.videoId}] ${artist}`);

    console.log('  → Downloading 30s clip...');
    const rawPath = downloadClip(v.videoId, rawBase, DEBUG);
    if (!rawPath) { console.warn('  ! Download failed — skipping'); continue; }
    console.log(`  ✓ Downloaded: ${path.basename(rawPath)}`);

    try {
      console.log('  → Normalising...');
      normalizeClip(rawPath, normPath, DEBUG);
    } catch (err) {
      console.warn(`  ! Normalise failed: ${err.message?.slice(0, 100)}`); continue;
    }

    try {
      console.log(`  → Burning title "${artist}"...`);
      addTitle(normPath, titPath, artist, DEBUG);
      titledPaths.push(titPath);
      titledArtists.push(artist);
      console.log('  ✓ Ready');
    } catch (err) {
      console.warn(`  ! Title burn failed: ${err.message?.slice(0, 100)}`);
      // Fall back to titled clip without text
      titledPaths.push(normPath);
      titledArtists.push(artist);
      console.warn('  ! Using clip without title overlay');
    }
  }

  if (titledPaths.length === 0) {
    console.log('\nNo clips ready. Exiting.');
    rmSync(WORK_DIR, { recursive: true });
    return;
  }

  console.log(`\nCrossfading ${titledPaths.length} clip(s)...`);
  const outputPath = path.join(WORK_DIR, `vkchronicle-${targetMonth}.mp4`);
  try {
    stitchWithXfade(titledPaths, outputPath, DEBUG);
  } catch (err) {
    console.error(`Stitch failed: ${err.message?.slice(0, 200)}`);
    if (!DEBUG) console.log('Re-run with --debug to see full ffmpeg output.');
    return;
  }
  const sizeMB = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ Output: ${outputPath} (${sizeMB} MB)`);

  const ytTitle = `VK Chronicle — ${monthName} ${year} | Visual Kei MV Roundup`;
  const artistLines = videos
    .filter(v => v.artist && v.artist !== v.videoId)
    .map(v => `• ${v.artist}${v.postUrl ? `  →  ${v.postUrl}` : ''}`)
    .join('\n');
  const description = [
    `A 30-second snapshot of every Visual Kei music video covered on VK Chronicle in ${monthName} ${year}.`,
    ...(artistLines ? ['', 'Featured artists:', artistLines] : []),
    '',
    '🔗 Full coverage: https://vkchronicle.com',
    '',
    '#VisualKei #VK #JRock #MusicVideo',
  ].join('\n');

  console.log('\nUploading to YouTube...');
  const youtube    = getYouTubeClient();
  const uploadedId = await uploadToYouTube(youtube, outputPath, ytTitle, description);
  console.log(`  ✓ https://www.youtube.com/watch?v=${uploadedId}`);

  const dataPath = path.join(SITE_REPO, '_data', 'monthly_video.yml');
  writeFileSync(dataPath, `month: "${monthName} ${year}"\nvideo_id: "${uploadedId}"\n`);
  execSync(`git -C "${SITE_REPO}" add "_data/monthly_video.yml"`, { stdio: 'pipe' });
  execSync(
    `git -C "${SITE_REPO}" diff --cached --quiet || ` +
    `git -C "${SITE_REPO}" commit -m "Monthly video: ${monthName} ${year}"`,
    { stdio: 'pipe' },
  );
  pushWithRebase();
  console.log('  ✓ Site updated');

  rmSync(WORK_DIR, { recursive: true });
  console.log('\nDone!');
}

main().catch(console.error);
