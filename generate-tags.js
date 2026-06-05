#!/usr/bin/env node
// generate-tags.js
// Run once from Terminal: node ~/Downloads/generate-tags.js
// Fetches all posts from your blog, generates tags with Anthropic AI, saves them back.
//
// Prerequisites:
//   npm install node-fetch@2 @anthropic-ai/sdk
//   (one-time: run in ~/Downloads folder)
//
// Set your secrets as env vars before running:
//   export BLOG_URL=https://disney-wait-times-lupt.vercel.app
//   export BLOG_PASSWORD=YOUR_ADMIN_PASSWORD
//   export ANTHROPIC_API_KEY=sk-ant-...

const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const BLOG_URL = process.env.BLOG_URL || 'https://disney-wait-times-lupt.vercel.app';
const BLOG_PASSWORD = process.env.BLOG_PASSWORD || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

if (!BLOG_PASSWORD) { console.error('Set BLOG_PASSWORD env var'); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY env var'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function getToken() {
  const r = await fetch(BLOG_URL + '/api/blog-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: BLOG_PASSWORD })
  });
  const d = await r.json();
  if (!d.token) throw new Error('Auth failed: ' + JSON.stringify(d));
  return d.token;
}

async function getAllPosts(token) {
  const r = await fetch(BLOG_URL + '/api/blog-index', {
    headers: { 'x-admin-key': token }
  });
  const posts = await r.json();
  return Array.isArray(posts) ? posts : [];
}

async function getPost(slug, token) {
  const r = await fetch(BLOG_URL + '/api/blog-post?slug=' + encodeURIComponent(slug), {
    headers: { 'x-admin-key': token }
  });
  if (!r.ok) return null;
  return r.json();
}

async function savePost(post, token) {
  const r = await fetch(BLOG_URL + '/api/blog-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
    body: JSON.stringify(post)
  });
  const d = await r.json();
  return r.ok && d.success;
}

async function generateTags(post) {
  const bodyText = (post.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  const prompt = `Generate 8-12 SEO keyword tags for this blog post. Return only a comma-separated list of tags, nothing else.\nTitle: ${post.title || ''}\nIntro: ${post.intro || ''}\nBody excerpt: ${bodyText}`;
  
  const message = await anthropic.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }]
  });
  
  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '';
  const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
  return tags;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n🏰 generate-tags.js — Theme Park Co-Pilot\n');
  
  console.log('Authenticating...');
  const token = await getToken();
  console.log('✓ Authenticated\n');
  
  console.log('Fetching post list...');
  const index = await getAllPosts(token);
  console.log('✓ Found ' + index.length + ' posts\n');
  
  let success = 0, failed = 0;
  
  for (let i = 0; i < index.length; i++) {
    const meta = index[i];
    const slug = meta.slug;
    process.stdout.write('['+(i+1)+'/'+index.length+'] ' + slug + ' ... ');
    
    try {
      // Fetch full post
      const post = await getPost(slug, token);
      if (!post) { console.log('✗ Could not fetch'); failed++; continue; }
      
      // Skip if already has tags
      if (post.tags && post.tags.length > 0) {
        console.log('⏭  Already has tags: ' + post.tags.join(', '));
        success++;
        continue;
      }
      
      // Generate tags
      const tags = await generateTags(post);
      if (!tags.length) { console.log('✗ No tags generated'); failed++; continue; }
      
      // Save post with tags
      post.tags = tags;
      post.updatedAt = new Date().toISOString();
      const saved = await savePost(post, token);
      
      if (saved) {
        console.log('✅ ' + tags.join(', '));
        success++;
      } else {
        console.log('✗ Save failed');
        failed++;
      }
      
      // Rate limit: 1 second between AI calls
      if (i < index.length - 1) await sleep(1000);
      
    } catch(e) {
      console.log('✗ Error: ' + e.message);
      failed++;
      await sleep(2000);
    }
  }
  
  console.log('\n' + '─'.repeat(50));
  console.log('Done! ✅ ' + success + ' succeeded  ✗ ' + failed + ' failed');
  console.log('─'.repeat(50) + '\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
