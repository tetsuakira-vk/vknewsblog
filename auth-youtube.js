/**
 * auth-youtube.js - One-time YouTube OAuth flow.
 * Uses the separate Desktop app credentials (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET)
 * and saves YOUTUBE_REFRESH_TOKEN to .env.
 * Usage: npm run auth-youtube
 */

import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import { readFileSync, writeFileSync } from 'fs';

const PORT = 3001; // different port to avoid clash with auth.js
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  REDIRECT_URI,
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/youtube'],
  prompt: 'consent',
});

console.log('\n=== VKNews - YouTube One-time Auth ===\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for you to log in...\n');

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const code  = parsed.searchParams.get('code');
  const error = parsed.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Auth failed. Check your terminal.</h2>');
    console.error('Auth error:', error);
    server.close();
    return;
  }

  if (code) {
    try {
      const { tokens } = await oauth2Client.getToken(code);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>YouTube auth successful! You can close this tab.</h2>');

      const envPath = new URL('.env', import.meta.url).pathname;
      let env = readFileSync(envPath, 'utf8');

      if (env.includes('YOUTUBE_REFRESH_TOKEN=')) {
        env = env.replace(/YOUTUBE_REFRESH_TOKEN=.*/, `YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        env = env.trimEnd() + `\nYOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
      }
      writeFileSync(envPath, env);

      console.log('✓ YOUTUBE_REFRESH_TOKEN saved to .env');
      console.log('\nYou can now run:');
      console.log('  node sync-playlist.js');
      console.log('  node create-monthly-video.js\n');
    } catch (err) {
      console.error('Failed to exchange code:', err.message);
    } finally {
      server.close();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}/callback ...`);
});
