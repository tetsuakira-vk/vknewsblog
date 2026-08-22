/**
 * cleanup.js - Mass delete old Blogger posts
 *
 * Usage:
 *   node cleanup.js --list              Preview what would be deleted
 *   node cleanup.js --delete            Delete all old posts (before today)
 *   node cleanup.js --delete --before 2025-01-01   Delete posts before a specific date
 *
 * Safe: Blogger API posts.list never returns pages — your About/static pages are untouched.
 * Default cutoff is today, preserving everything posted by the new pipeline.
 */

import 'dotenv/config';
import { google } from 'googleapis';

const args = process.argv.slice(2);
const dryRun = !args.includes('--delete');
const beforeIdx = args.indexOf('--before');
const beforeArg = beforeIdx !== -1 ? args[beforeIdx + 1] : null;

// Default: delete everything published before today (pipeline posts are from today onwards)
const today = new Date();
today.setHours(0, 0, 0, 0);
const cutoffDate = beforeArg ? new Date(beforeArg) : today;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

async function getAllPosts() {
  const posts = [];
  let pageToken;

  do {
    const res = await blogger.posts.list({
      blogId,
      maxResults: 500,
      pageToken,
      status: 'live',
    });
    if (res.data.items) posts.push(...res.data.items);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return posts;
}

async function main() {
  console.log('Fetching all posts...');
  const allPosts = await getAllPosts();
  console.log(`Total posts on blog: ${allPosts.length}`);

  const toDelete = allPosts.filter(p => {
    if (!p.published) return false;
    const pub = new Date(p.published);
    return !isNaN(pub.getTime()) && pub < cutoffDate;
  });
  const toKeep = allPosts.length - toDelete.length;

  const cutoffStr = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth()+1).padStart(2,'0')}-${String(cutoffDate.getDate()).padStart(2,'0')}`;
  console.log(`\nCutoff date: ${cutoffStr}`);
  console.log(`Posts to delete: ${toDelete.length}`);
  console.log(`Posts to keep:   ${toKeep}`);

  if (dryRun) {
    console.log('\n--- DRY RUN (use --delete to actually delete) ---');
    toDelete.slice(0, 20).forEach(p =>
      console.log(`  [${(p.published || '').split('T')[0]}] ${p.title}`)
    );
    if (toDelete.length > 20) console.log(`  ... and ${toDelete.length - 20} more`);
    return;
  }

  console.log('\nDeleting...');
  let deleted = 0;
  let failed = 0;

  for (const post of toDelete) {
    try {
      await blogger.posts.delete({ blogId, postId: post.id });
      console.log(`  ✓ Deleted: [${(post.published || '').split('T')[0]}] ${post.title}`);
      deleted++;
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`  ✗ Failed: ${post.title} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Deleted: ${deleted}, Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
