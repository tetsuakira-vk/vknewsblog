/**
 * patch-labels.js - Add 'Reviews' label to recently posted review posts
 * Run once: node patch-labels.js
 */
import 'dotenv/config';
import { google } from 'googleapis';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

async function main() {
  const res = await blogger.posts.list({ blogId, maxResults: 20, status: 'live' });
  const posts = res.data.items || [];

  // Find posts with 'Album Review' label but missing 'Reviews'
  const toFix = posts.filter(p =>
    (p.labels || []).includes('Album Review') && !(p.labels || []).includes('Reviews')
  );

  console.log(`Found ${toFix.length} review post(s) missing the 'Reviews' label`);

  for (const post of toFix) {
    const newLabels = ['Reviews', ...(post.labels || [])];
    await blogger.posts.update({
      blogId,
      postId: post.id,
      requestBody: { title: post.title, content: post.content, labels: newLabels },
    });
    console.log(`  ✓ Patched: "${post.title}"`);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Done.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
