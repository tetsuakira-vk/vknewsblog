/**
 * create-evergreen-pages.js
 *
 * Generates and publishes 3 SEO-optimised evergreen Blogger pages:
 *   1. Visual Kei Explained: A Complete Guide
 *   2. Getting Into Visual Kei: Where to Start
 *   3. Best Visual Kei Albums of All Time
 *
 * Usage:
 *   node create-evergreen-pages.js            — generate + publish all 3
 *   node create-evergreen-pages.js --dry-run  — print HTML to console, no publish
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';

// ─── Auth ─────────────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });
const blogId = process.env.BLOGGER_BLOG_ID;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Page definitions ─────────────────────────────────────────────────────────

const PAGES = [
  {
    title: 'Visual Kei Explained: A Complete Guide',
    slug: 'visual-kei-explained',
    prompt: `You are a music journalist writing an authoritative, SEO-optimised guide page for a Visual Kei news blog (vknyusu.blogspot.com).

Write a complete, detailed guide titled "Visual Kei Explained: A Complete Guide".

Cover these sections in order:
1. What is Visual Kei? (define the genre — music + fashion + performance art movement)
2. History & Origins (late 1980s Japan, X Japan, hide, Buck-Tick, Malice Mizer, evolution through 90s/2000s/2010s to present)
3. The Sound (musical characteristics — heavy guitars, dramatic arrangements, wide tonal range from pop-punk to death metal)
4. The Look (fashion: elaborate costumes, androgynous aesthetics, heavy makeup, dyed hair, visual storytelling)
5. Sub-genres (kote-kei, oshare-kei, nagoya-kei, angura-kei, eroguro-kei — brief explanation of each)
6. Iconic Bands to Know (X Japan, Buck-Tick, Malice Mizer, Dir en grey, The GazettE, Versailles, Gazette — 1-2 sentences each)
7. Visual Kei Today (current active scene, international fanbase, overseas tours)
8. Where to Discover More (mention vk.gy, Last.fm, and this blog)

Writing style: engaging, authoritative, informative. Written for someone who has heard the term but knows nothing.
Length: 900–1100 words of body text.

Return ONLY raw HTML. Use these tags only: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>, <a href="...">.
No <html>, <head>, <body>, <style> wrappers. No markdown. No code fences.
Make it genuinely useful — Google rewards depth and accuracy.`,
  },
  {
    title: 'Getting Into Visual Kei: Where to Start',
    slug: 'getting-into-visual-kei',
    prompt: `You are a music journalist writing an authoritative, SEO-optimised guide page for a Visual Kei news blog (vknyusu.blogspot.com).

Write a complete beginner's guide titled "Getting Into Visual Kei: Where to Start".

Cover these sections in order:
1. Why Visual Kei? (hook — what makes it unlike anything else in music)
2. Start Here: Gateways by Sound (recommend entry points by familiar genre taste):
   - If you like metal / hard rock → Dir en grey, The GazettE, Deviloof
   - If you like pop-rock / punk → An Cafe, Gazette mid-era, SID
   - If you like gothic / dark orchestral → Malice Mizer, Versailles, Moi dix Mois
   - If you like glam / theatrical → Buck-Tick, Plastic Tree, BUCK-TICK
3. Essential Listening: 10 Albums to Start With (pick well-known landmark albums — Vulgar, Stacked Rubbish, Merveilles, Lareine etc. — 2-3 sentences on why each matters)
4. Where to Listen (Spotify, YouTube, CDJapan for imports, Bandcamp for indie releases)
5. Where to Follow the Scene (vk.gy for news, this blog for English coverage, Last.fm for recommendations, r/visualkei on Reddit)
6. Going Deeper: Concerts and Merchandise (overseas tours info, merch from CDJapan/YesAsia)
7. Common Questions (FAQ format — "Is Visual Kei just Japanese metal?", "Do I need to understand Japanese?", "Is VK only for women?", "Is the scene dying?")

Writing style: warm, enthusiastic, like a knowledgeable friend recommending music. Not academic.
Length: 900–1100 words of body text.

Return ONLY raw HTML. Use these tags only: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>, <a href="...">.
No <html>, <head>, <body>, <style> wrappers. No markdown. No code fences.`,
  },
  {
    title: 'Best Visual Kei Albums of All Time',
    slug: 'best-visual-kei-albums',
    prompt: `You are a music journalist writing an authoritative, SEO-optimised list page for a Visual Kei news blog (vknyusu.blogspot.com).

Write a definitive list titled "Best Visual Kei Albums of All Time".

Include exactly 20 albums. For each album write:
- Band name and album title as heading
- Release year
- A compelling 3–4 sentence description: what the album sounds like, why it matters to the genre, what makes it stand out, who should listen to it.

Choose landmark albums that represent the breadth of VK — include classics from the 90s through to 2020s, and mix of genres within VK.

Suggested picks (you can include all or swap some for better choices):
X Japan – Blue Blood (1989), Buck-Tick – Aku no Hana (1990), Malice Mizer – Merveilles (1998), Dir en grey – Vulgar (2003), The GazettE – Stacked Rubbish (2007), Versailles – Jubilee (2010), Nightmare – Libido (2004), Alice Nine – Gemini (2008), An Cafe – Kakusei Heroism (2007), SID – M&W (2010), Deviloof – Debauchery (2018), Mejibray – Theatrical (2014), MUCC – Homura Uta (2003), Plastic Tree – Utsusemi (2003), Kizu – Kasou (2019), exist†trace – Spiral Daisakusen (2012), D – Genetic World (2007), Moi dix Mois – Dix Infernal (2004), Black:List – (choose a strong recent album), the god and death stars – (choose a strong album).

After the list, add a closing section: "What Makes These Albums Special" (2 paragraphs about VK as an art form).

Then add: "Keep Up With New Releases" — a paragraph directing readers to this blog and the New Releases page.

Writing style: authoritative music criticism. Each entry should feel considered, not lazy.
Length: 1200–1500 words total.

Return ONLY raw HTML. Use these tags only: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>.
No <html>, <head>, <body>, <style> wrappers. No markdown. No code fences.`,
  },
];

// ─── Blogger page helpers ──────────────────────────────────────────────────────

async function getExistingPages() {
  const res = await blogger.pages.list({ blogId, status: 'live' });
  return res.data.items || [];
}

async function upsertPage(title, htmlContent) {
  const existing = await getExistingPages();
  const match = existing.find(p => p.title === title);

  const wrappedContent = wrapPage(title, htmlContent);

  if (match) {
    console.log(`  → Updating existing page: "${title}"`);
    await blogger.pages.update({
      blogId,
      pageId: match.id,
      requestBody: { title, content: wrappedContent },
    });
    return { action: 'updated', url: match.url };
  } else {
    console.log(`  → Creating new page: "${title}"`);
    const res = await blogger.pages.insert({
      blogId,
      requestBody: { title, content: wrappedContent },
    });
    return { action: 'created', url: res.data.url };
  }
}

function wrapPage(title, body) {
  return `<div class="evergreen-page">
<h1 class="evergreen-title">${title}</h1>
${body}
</div>

<style>
.evergreen-page { max-width: 760px; margin: 0 auto; padding: 0 16px 48px; }
.evergreen-title { font-family: 'Playfair Display', serif; font-size: 2rem; color: #fff; margin-bottom: 24px; }
.evergreen-page h2 { font-size: 1.25rem; font-weight: 700; color: #fff; margin-top: 2em; margin-bottom: 0.5em; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; }
.evergreen-page h3 { font-size: 1rem; font-weight: 600; color: #ecac0d; margin-top: 1.5em; margin-bottom: 0.3em; }
.evergreen-page p { font-size: 0.95rem; line-height: 1.8; color: rgba(255,255,255,0.75); margin-bottom: 1em; }
.evergreen-page ul { padding-left: 20px; margin-bottom: 1em; }
.evergreen-page li { font-size: 0.95rem; line-height: 1.7; color: rgba(255,255,255,0.7); margin-bottom: 4px; }
.evergreen-page a { color: #ecac0d; text-decoration: underline; text-decoration-color: rgba(236,172,13,0.3); }
.evergreen-page strong { color: #fff; font-weight: 600; }
</style>`;
}

// ─── Content generation ────────────────────────────────────────────────────────

async function generateContent(page) {
  console.log(`\nGenerating: "${page.title}"...`);
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{ role: 'user', content: page.prompt }],
  });
  return msg.content[0].text.trim();
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Optional: node create-evergreen-pages.js --page="Getting Into"
  const pageFilter = process.argv.find(a => a.startsWith('--page='))?.split('=')[1]?.toLowerCase();
  const pagesToRun = pageFilter ? PAGES.filter(p => p.title.toLowerCase().includes(pageFilter)) : PAGES;

  for (const page of pagesToRun) {
    const html = await generateContent(page);

    if (DRY_RUN) {
      console.log('\n─────────────────────────────────────────────────────────');
      console.log(`TITLE: ${page.title}`);
      console.log('─────────────────────────────────────────────────────────');
      console.log(html.slice(0, 800), '\n...[truncated]');
      continue;
    }

    try {
      const result = await upsertPage(page.title, html);
      console.log(`  ✓ ${result.action}: ${result.url}`);
    } catch (err) {
      console.error(`  ✗ Failed to publish "${page.title}": ${err.message}`);
    }

    // Brief pause between API calls
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
