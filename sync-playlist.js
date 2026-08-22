/**
 * sync-playlist.js
 *
 * Maintains a growing YouTube playlist of VK music videos discovered by the pipeline.
 * On first run, creates the playlist and saves its ID to .env as YOUTUBE_VK_PLAYLIST_ID.
 * On subsequent runs, adds any videos from monthly-videos.json not yet in the playlist.
 * Also writes _data/vk_playlist.yml to vkchronicle so the site can embed it.
 *
 * Usage:
 *   node sync-playlist.js          # sync new videos to the playlist
 *   node sync-playlist.js --dry    # preview what would be added without making changes
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { pushWithRebase } from './lib/jekyll.js';

const MONTHLY_FILE = './monthly-videos.json';
const SYNCED_FILE  = './synced-playlist.json'; // tracks which video IDs are already in the playlist
const SITE_REPO    = '/Users/robertnelson/vkchronicle';
const ENV_FILE     = new URL('.env', import.meta.url).pathname;
const DRY_RUN      = process.argv.includes('--dry');

// ── Auth ──────────────────────────────────────────────────────────────────────

function getYouTubeClient() {
  const auth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth });
}

// ── Playlist management ───────────────────────────────────────────────────────

async function createPlaylist(youtube) {
  const res = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: 'VK Chronicle — Visual Kei Music Videos',
        description:
          'A growing collection of Visual Kei music videos, MVs, and PVs featured on VK Chronicle.\n\n' +
          'Updated regularly as new releases are covered.\n\n' +
          '🔗 Full news coverage: https://vkchronicle.com\n\n' +
          '#VisualKei #VK #JRock #MusicVideo',
        tags: ['visual kei', 'vk', 'j-rock', 'music video', 'playlist'],
      },
      status: { privacyStatus: 'public' },
    },
  });

  const id = res.data.id;

  // Persist the playlist ID into .env so it survives across runs
  let env = readFileSync(ENV_FILE, 'utf8');
  if (env.includes('YOUTUBE_VK_PLAYLIST_ID=')) {
    env = env.replace(/YOUTUBE_VK_PLAYLIST_ID=.*/, `YOUTUBE_VK_PLAYLIST_ID=${id}`);
  } else {
    env = env.trimEnd() + `\nYOUTUBE_VK_PLAYLIST_ID=${id}\n`;
  }
  writeFileSync(ENV_FILE, env);

  console.log(`  ✓ Playlist created: https://www.youtube.com/playlist?list=${id}`);
  console.log(`  → YOUTUBE_VK_PLAYLIST_ID=${id} saved to .env`);
  return id;
}

async function addToPlaylist(youtube, playlistId, videoId) {
  await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: 'youtube#video',
          videoId,
        },
      },
    },
  });
}

// ── Synced-IDs tracking ───────────────────────────────────────────────────────

function loadSynced() {
  if (!existsSync(SYNCED_FILE)) return new Set();
  try { return new Set(JSON.parse(readFileSync(SYNCED_FILE, 'utf8'))); } catch { return new Set(); }
}

function saveSynced(set) {
  writeFileSync(SYNCED_FILE, JSON.stringify([...set], null, 2));
}

// ── Site data update ──────────────────────────────────────────────────────────

function updateSiteData(playlistId, totalCount) {
  const dataPath = `${SITE_REPO}/_data/vk_playlist.yml`;
  writeFileSync(dataPath, `playlist_id: "${playlistId}"\nvideo_count: ${totalCount}\n`);
  try {
    execSync(`git -C "${SITE_REPO}" add "_data/vk_playlist.yml"`, { stdio: 'pipe' });
    execSync(
      `git -C "${SITE_REPO}" diff --cached --quiet || ` +
      `git -C "${SITE_REPO}" commit -m "Update VK playlist (${totalCount} videos)"`,
      { stdio: 'pipe' },
    );
    pushWithRebase();
    console.log('  ✓ Site updated');
  } catch (err) {
    console.warn(`  Site update error: ${err.stderr?.toString().slice(0, 120) || err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('-- DRY RUN — no changes will be made --\n');

  const youtube = getYouTubeClient();

  // Resolve or create the playlist
  let playlistId = process.env.YOUTUBE_VK_PLAYLIST_ID;
  if (!playlistId) {
    if (DRY_RUN) {
      console.log('No YOUTUBE_VK_PLAYLIST_ID in .env — would create a new playlist.');
    } else {
      console.log('No playlist found — creating one...');
      playlistId = await createPlaylist(youtube);
    }
  } else {
    console.log(`Using playlist: https://www.youtube.com/playlist?list=${playlistId}`);
  }

  // Load all pipeline-discovered videos
  const allVideos = existsSync(MONTHLY_FILE)
    ? JSON.parse(readFileSync(MONTHLY_FILE, 'utf8'))
    : [];

  if (allVideos.length === 0) {
    console.log('monthly-videos.json is empty — nothing to sync.');
    return;
  }

  // Determine which haven't been synced yet
  const synced = loadSynced();
  const pending = allVideos.filter(v => v.videoId && !synced.has(v.videoId));

  if (pending.length === 0) {
    console.log(`All ${allVideos.length} video(s) already in playlist.`);
    return;
  }

  console.log(`\nAdding ${pending.length} new video(s) to playlist...\n`);

  let added = 0;
  for (const v of pending) {
    const label = `${v.artist || 'Unknown'} — ${v.postTitle || v.videoId}`;
    if (DRY_RUN) {
      console.log(`  [dry] Would add: ${label}`);
      continue;
    }
    try {
      await addToPlaylist(youtube, playlistId, v.videoId);
      synced.add(v.videoId);
      added++;
      console.log(`  ✓ Added: ${label}`);
      // Polite delay — YouTube API quota is 50 units per playlistItems.insert
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`  ! Failed to add ${v.videoId}: ${err.message?.slice(0, 100)}`);
    }
  }

  if (!DRY_RUN) {
    saveSynced(synced);
    if (added > 0 && playlistId) updateSiteData(playlistId, synced.size);
    console.log(`\nDone. Added ${added} video(s). Playlist total: ${synced.size}.`);
  }
}

main().catch(console.error);
