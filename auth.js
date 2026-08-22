/**
 * auth.js - Run this ONCE to get your Google OAuth refresh token.
 * After running, paste the printed GOOGLE_REFRESH_TOKEN into your .env file.
 * Usage: npm run auth
 */

import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import { readFileSync, writeFileSync } from 'fs';

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: [
    'https://www.googleapis.com/auth/blogger',
    'https://www.googleapis.com/auth/analytics.readonly',
  ],
  prompt: 'consent', // force consent screen so we always get a refresh token
});

console.log('\n=== VKNews Blog - One-time Google Auth ===\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for you to log in...\n');

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const code = parsedUrl.searchParams.get('code');
  const error = parsedUrl.searchParams.get('error');

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
      res.end('<h2>Auth successful! You can close this tab and return to your terminal.</h2>');

      // Write refresh token back into .env
      const envPath = new URL('.env', import.meta.url).pathname;
      let envContent = readFileSync(envPath, 'utf8');
      envContent = envContent.replace(
        /GOOGLE_REFRESH_TOKEN=.*/,
        `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`
      );
      writeFileSync(envPath, envContent);

      console.log('✓ Refresh token saved to .env');
      console.log('\nYou are all set. Run the pipeline with: npm start\n');
    } catch (err) {
      console.error('Failed to exchange code for token:', err.message);
    } finally {
      server.close();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}/callback ...`);
});
