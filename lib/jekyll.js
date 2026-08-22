import { writeFileSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

export { readdirSync }; // re-export for scripts that scan _bands/

export const SITE_REPO_PATH = process.env.SITE_REPO_PATH || '/Users/robertnelson/vkchronicle';
export const SITE_BASE_URL  = 'https://vkchronicle.com';

export function proxiedImageUrl(url, w = 1200) {
  if (!url) return null;
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${w}&output=jpg`;
}

// Returns true if there are staged changes ready to commit
function hasStagedChanges() {
  try { execSync(`git -C "${SITE_REPO_PATH}" diff --cached --quiet`, { stdio: 'pipe' }); return false; }
  catch { return true; }
}

function gitCommitAndPush(commitMsg) {
  if (!hasStagedChanges()) { console.log('  (no changes to commit)'); return; }
  execSync(`git -C "${SITE_REPO_PATH}" commit -m "${commitMsg}"`, { stdio: 'pipe' });
  pushWithRebase();
}

// Minimal standalone Telegram alert — deliberately doesn't depend on any
// per-script sendTelegram() implementation, so it works from any caller of
// pushWithRebase(). Silently no-ops if not configured, and never throws.
async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Non-fatal
  }
}

// Push local commits to origin/main. If rejected because origin has commits we
// don't (from CI, from a manual edit, from anything other than this checkout),
// pull --rebase on top of them and retry once. Without this, a single foreign
// commit permanently wedges every future push — which is what happened for two
// straight weeks starting 2026-07-22, silently, because nothing alerted on it.
export function pushWithRebase(attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    try {
      execSync(`git -C "${SITE_REPO_PATH}" push origin main`, { stdio: 'pipe' });
      return;
    } catch (err) {
      if (i === attempts) {
        sendTelegramAlert(
          `⚠️ <b>VKNews git push failed</b> after ${attempts} attempt(s) (incl. pull --rebase retry).\n` +
          `Repo may be diverged or blocked. Manual check needed.\n<code>${String(err.message || err).slice(0, 300)}</code>`
        );
        throw err;
      }
      console.warn(`  → Push rejected, pulling --rebase and retrying (${i}/${attempts})...`);
      execSync(`git -C "${SITE_REPO_PATH}" pull --rebase origin main`, { stdio: 'pipe' });
    }
  }
}

// ─── Publish a new dated _post ─────────────────────────────────────────────────

export function publishToJekyll(title, labels, content, opts = {}) {
  const { imageUrl = null, sourceUrl = null } = opts;
  const date    = new Date();
  const dateStr = date.toISOString().split('T')[0];
  const slug    = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  const filename = `${dateStr}-${slug}.md`;
  const filepath = path.join(SITE_REPO_PATH, '_posts', filename);
  const year     = dateStr.slice(0, 4);
  const month    = dateStr.slice(5, 7);
  const postUrl  = `${SITE_BASE_URL}/${year}/${month}/${slug}/`;

  const safeTitle  = title.replace(/"/g, '\\"');
  const labelsYaml = `[${labels.map(l => `"${l.replace(/"/g, '\\"')}"`).join(', ')}]`;

  let frontMatter = `---\nlayout: post\ntitle: "${safeTitle}"\ndate: ${date.toISOString()}\nlabels: ${labelsYaml}\n`;
  if (sourceUrl) frontMatter += `source: "${sourceUrl}"\n`;
  if (imageUrl)  frontMatter += `image: "${proxiedImageUrl(imageUrl)}"\n`;
  frontMatter += `---\n\n`;

  writeFileSync(filepath, frontMatter + content + '\n');

  const commitMsg = `Post: ${safeTitle.replace(/'/g, '').slice(0, 60)}`;
  execSync(`git -C "${SITE_REPO_PATH}" add "_posts/${filename}"`, { stdio: 'pipe' });
  gitCommitAndPush(commitMsg);

  console.log(`  ✓ Published: "${title}"`);
  return postUrl;
}

// ─── Write / overwrite a static page file and push ────────────────────────────

export function updateJekyllPage(repoRelativePath, frontmatter, bodyContent, commitMsg) {
  const fullPath = path.join(SITE_REPO_PATH, repoRelativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });

  let fm = '---\n';
  for (const [k, v] of Object.entries(frontmatter)) {
    fm += typeof v === 'string'
      ? `${k}: "${v.replace(/"/g, '\\"')}"\n`
      : `${k}: ${JSON.stringify(v)}\n`;
  }
  fm += '---\n\n';

  writeFileSync(fullPath, fm + bodyContent);

  const safeMsg = commitMsg.replace(/['"]/g, '').slice(0, 70);
  execSync(`git -C "${SITE_REPO_PATH}" add "${repoRelativePath}"`, { stdio: 'pipe' });
  gitCommitAndPush(safeMsg);
  console.log(`  ✓ Page updated: ${repoRelativePath}`);
}

// ─── Write multiple files then push once (for band batch updates) ─────────────

export function batchUpdateJekyll(files, addGlob, commitMsg) {
  for (const { filePath, content } of files) {
    const fullPath = path.join(SITE_REPO_PATH, filePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  const safeMsg = commitMsg.replace(/['"]/g, '').slice(0, 70);
  execSync(`git -C "${SITE_REPO_PATH}" add ${addGlob}`, { stdio: 'pipe' });
  gitCommitAndPush(safeMsg);
  console.log(`  ✓ Batch committed: ${files.length} files`);
}

// ─── Write a _data/*.json file and push ───────────────────────────────────────

export function updateJekyllData(dataFilename, data, commitMsg) {
  const filePath = `_data/${dataFilename}`;
  const fullPath = path.join(SITE_REPO_PATH, filePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(data, null, 2));

  const safeMsg = commitMsg.replace(/['"]/g, '').slice(0, 70);
  execSync(`git -C "${SITE_REPO_PATH}" add "${filePath}"`, { stdio: 'pipe' });
  gitCommitAndPush(safeMsg);
  console.log(`  ✓ Data updated: ${filePath}`);
}

export async function pingSitemap() {
  try {
    await fetch(`https://www.google.com/ping?sitemap=${SITE_BASE_URL}/sitemap.xml`,
      { signal: AbortSignal.timeout(8000) });
  } catch { /* non-fatal */ }
}
