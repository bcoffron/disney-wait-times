

// ============================================================
// STATE
// ============================================================
const API_BASE = '';
let token = sessionStorage.getItem('tpcp_admin_token') || '';
let allPosts = [];
let featuredSlug = null;
// Whether featuredSlug currently reflects the server's state. A failed load
// marks the state UNKNOWN (last-known value kept for display) instead of
// resetting it to null — null means "known to be unfeatured," a different
// fact, and the unfeature write is refused while the state is unknown.
let featuredKnown = false;
let currentPost = null
let imgManagerContext = 'hero'
let quill = null;
let loginFailures = 0;
let loginLocked = false;
let isDirty = false;
let lastSavedState = null;
let appSettings = { byline: 'By the Theme Park Co-Pilot Team', readTimeMode: 'auto', postsPerPage: 30 };

// FIX 2: Upload queue state
let uploadQueue = [];
let uploadDone = false;
// FIX 3: Batch upload state
let batchZip = null;
let batchPosts = [];
let batchImages = {};
// IN-USE DELETE state
let _deleteInUseUrl = null;
let _deleteInUseMultiUrls = null;
let _deleteFromView = null;

// IMAGE SELECTION state
let imgSelectMode = false;
let selectedImgUrls = new Set();
var pinnedSlugs = [];
var isLoadingImages = false;

// ============================================================
// NORMALIZE URL (module-level so deleteImage and loadImagesInline can both use it)
// ============================================================
// DIRTY TRACKING
// ============================================================
function markDirty() { isDirty = true; }

function cancelEdit() {
  const dest = (currentPost && currentPost.published) ? 'posts' : 'drafts';
  if (!isDirty) { showView(dest); return; }
  document.getElementById('unsaved-modal').classList.add('active');
}

function leaveWithoutSaving() {
  closeModal('unsaved-modal');
  isDirty = false;
  const dest = (currentPost && currentPost.published) ? 'posts' : 'drafts';
  showView(dest);
}

// ============================================================
// AUTO READ TIME
// ============================================================
function calcReadTime(htmlBody) {
  const text = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const wordCount = text.split(' ').filter(w => w.length > 0).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

// ============================================================
// LOGIN
// ============================================================
function doLogin() {
  if (loginLocked) return;
  const pw = document.getElementById('pw-input').value.trim();
  if (!pw) return;
  const btn = document.getElementById('login-btn');
  btn.textContent = 'Checking...';
  btn.disabled = true;
  fetch(API_BASE + '/api/blog-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  }).then(r => r.json()).then(data => {
    if (data.token) {
      token = data.token;
      sessionStorage.setItem('tpcp_admin_token', token);
      sessionStorage.setItem('tpcp_admin_pw', pw);
      loginFailures = 0;
      showApp();
    } else {
document.getElementById('login-error').textContent = 'Incorrect password.';
      btn.textContent = 'Enter';
      if (loginFailures >= 5) {
        loginLocked = true;
        btn.disabled = true;
        document.getElementById('login-error').textContent = 'Too many attempts. Try again later.';
        setTimeout(() => { loginLocked = false; btn.disabled = false; btn.textContent = 'Enter'; }, 60000);
      } else { btn.disabled = false; }
    }
  }).catch(() => {
    document.getElementById('login-error').textContent = 'Network error. Try again.';
    btn.textContent = 'Enter';
    btn.disabled = false;
  });
}

// ============================================================
// FORGOT PASSWORD / RESET
// ============================================================
function showResetRequest() {
  document.querySelector('.login-card').style.display = 'none';
  document.getElementById('reset-request-form').style.display = 'block';
}

function showLogin() {
  document.getElementById('reset-request-form').style.display = 'none';
  document.getElementById('reset-confirm-form').style.display = 'none';
  document.querySelector('.login-card').style.display = 'block';
}

async function submitResetRequest() {
  const email = document.getElementById('reset-email').value;
  if (!email) { showToast('Please enter your email', 'error'); return; }
  await fetch(API_BASE + '/api/blog-reset-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  showToast('Reset link sent if email is registered', 'success');
  showLogin();
}

async function submitNewPassword() {
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;
  if (!newPassword || newPassword.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
  if (newPassword !== confirmPassword) { showToast('Passwords do not match', 'error'); return; }
  const token = new URLSearchParams(window.location.search).get('reset');
  if (!token) { showToast('Invalid reset link', 'error'); return; }
  const res = await fetch(API_BASE + '/api/blog-reset-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword })
  });
  const data = await res.json();
if (data.success) { showToast('Password updated successfully', 'success'); window.history.replaceState({}, '', '/admin'); showLogin(); }
  else { showToast(data.error || 'Reset failed', 'error'); }
}

// ============================================================
// SHOW/HIDE PASSWORD TOGGLE
// ============================================================
function togglePasswordVisibility(inputId, btn) {
  var input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  } else {
    input.type = 'password';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }
}

document.addEventListener('DOMContentLoaded', function()  {
  document.getElementById('pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (token) showApp();
  const forgotLink = document.getElementById('forgot-pw-link');
  if (forgotLink) forgotLink.addEventListener('click', function(e) {
    e.preventDefault();
    showResetRequest();
  });
  const resetToken = new URLSearchParams(window.location.search).get('reset');
  if (resetToken) {
    document.querySelector('.login-card').style.display = 'none';
    document.getElementById('reset-confirm-form').style.display = 'block';
  }
});
  
function doLogout() {
  sessionStorage.removeItem('tpcp_admin_token');
  token = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

// ============================================================
// APP INIT
// ============================================================
async function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  initQuill();
  await loadPosts();
  loadSettings();
  const savedView = sessionStorage.getItem('admin_current_view') || 'posts';
  const savedPost = sessionStorage.getItem('admin_current_post');
  if (savedView === 'editor' && savedPost) {
    await openPost(savedPost);
  } else {
    showView(savedView);
  }
}
// ============================================================
// VIDEO BLOT
// ============================================================
const BlockEmbed = Quill.import('blots/block/embed');

class VideoBlot extends BlockEmbed {
  static create(url) {
    const node = super.create();
    node.setAttribute('contenteditable', 'false');
    node.style.cssText = 'position:relative;padding-bottom:56.25%;height:0;overflow:hidden;margin:24px 0;border-radius:8px;';
    const iframe = document.createElement('iframe');
    iframe.setAttribute('src', url);
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px;';
    node.appendChild(iframe);
    return node;
  }
  static value(node) {
    const iframe = node.querySelector('iframe');
    return iframe ? iframe.getAttribute('src') : '';
  }
}
VideoBlot.blotName = 'video';
VideoBlot.tagName = 'div';
VideoBlot.className = 'ql-video-wrapper';
Quill.register(VideoBlot, true);

// ============================================================
// RAW EMBED BLOT
// ============================================================
class RawEmbedBlot extends BlockEmbed {
  static create(html) {
    const node = super.create();
    node.setAttribute('contenteditable', 'false');
    node.style.cssText = 'margin:24px 0;';
    // Store the original raw HTML so save always uses the original blockquote+script
    node.setAttribute('data-raw-embed', html);
    // Set innerHTML for display, then strip scripts so embed.js never fires in editor
    node.innerHTML = html;
    node.querySelectorAll('script').forEach(s => s.remove());
    return node;
  }
  static value(node) {
    // Always return the original raw HTML, not whatever the DOM was mutated to
    return node.getAttribute('data-raw-embed') || node.innerHTML;
  }
}
RawEmbedBlot.blotName = 'rawembed';
RawEmbedBlot.tagName = 'div';
RawEmbedBlot.className = 'ql-raw-embed';
Quill.register(RawEmbedBlot, true);

function initQuill() {
  if (quill) return;
  const toolbarOptions = {
    container: [
      [{ 'header': 2 }],
      ['bold', 'italic'],
      [{ 'list': 'ordered' }, { 'list': 'bullet' }],
      ['link', 'image'],
      ['video', 'embed'],
      ['undo', 'redo']
      ],
    handlers: {
      image: function() { openImageManager('quill'); },
      undo: function() { if (quill) quill.history.undo(); },
      redo: function() { if (quill) quill.history.redo(); },
      video: function() {
      const code = prompt('Paste the YouTube or Facebook embed code (<iframe ...>):');
      if (!code) return;
      const srcMatch = code.match(/src=["']([^"']+)["']/);
      if (!srcMatch) {
         alert('Could not find a src URL in that embed code. Make sure you paste the full <iframe> code from YouTube or Facebook.');
         return;
      }
      const range = quill.getSelection(true);
      quill.insertEmbed(range.index, 'video', srcMatch[1], Quill.sources.USER);
      quill.setSelection(range.index + 1, Quill.sources.SILENT);
      },
      embed: async function() {
      const url = prompt('Paste a TikTok or Instagram post URL:');
      if (!url) return;
      const trimmed = url.trim();
      if (!trimmed.includes('tiktok.com') && !trimmed.includes('instagram.com')) {
        alert('Only TikTok and Instagram URLs are supported. For YouTube, use the video button.');
        return;
      }
      const range = quill.getSelection(true);
      try {
        const token = sessionStorage.getItem('tpcp_admin_token');
        const response = await fetch('/api/social-oembed', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': token,
          },
          body: JSON.stringify({ url: trimmed }),
        });
        const data = await response.json();
        if (!response.ok) {
          alert(data.error || 'Could not get embed. Try again.');
          return;
        }
        quill.insertEmbed(range.index, 'rawembed', data.html, Quill.sources.USER);
        quill.setSelection(range.index + 1, Quill.sources.SILENT);
      } catch (err) {
        alert('Network error. Try again.');
      }
      }
    }
  };
  quill = new Quill('#quill-editor', { theme: 'snow', modules: { toolbar: toolbarOptions, history: { delay: 1000, maxStack: 50, userOnly: true } } });
  const toolbar = document.querySelector('.ql-toolbar');
  if (toolbar) {
    const undoBtn = toolbar.querySelector('.ql-undo');
    const redoBtn = toolbar.querySelector('.ql-redo');
    if (undoBtn) { undoBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>'; undoBtn.title = 'Undo'; }
    if (redoBtn) { redoBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 14l4-4-4-4"/><path d="M19 10H8a4 4 0 0 0 0 8h1"/></svg>'; redoBtn.title = 'Redo'; }
  }
  // Toolbar handlers for video and embed buttons
    quill.on('text-change', () => { markDirty(); });
  quill.on('text-change', function() {
    var imgs = quill.root.querySelectorAll('img');
    imgs.forEach(function(img) {
      img.removeAttribute('style');
      img.removeAttribute('width');
      img.removeAttribute('height');
    });
  });
}

// ============================================================
// SETTINGS
// ============================================================
async function loadSettings() {
try {
const r = await fetch(API_BASE + '/api/blog-settings');
if (r.ok) { const s = await r.json(); appSettings = { ...appSettings, ...s }; }
} catch(e) {}
applySettingsToUI();
}

function applySettingsToUI() {
const bylineEl = document.getElementById('s-byline');
const pppEl = document.getElementById('s-posts-per-page');
if (bylineEl) bylineEl.value = appSettings.byline || 'By the Theme Park Co-Pilot Team';
if (pppEl) pppEl.value = appSettings.postsPerPage || 30;
setReadTimeMode(appSettings.readTimeMode || 'auto', false);
}
function setReadTimeMode(mode, updateSettings = true) {
if (updateSettings) appSettings.readTimeMode = mode;
const autoBtn = document.getElementById('rt-auto-btn');
const manualBtn = document.getElementById('rt-manual-btn');
const rtInput = document.getElementById('f-readtime');
if (autoBtn) autoBtn.classList.toggle('active', mode === 'auto');
if (manualBtn) manualBtn.classList.toggle('active', mode === 'manual');
if (rtInput) { rtInput.disabled = mode === 'auto'; rtInput.style.opacity = mode === 'auto' ? '0.6' : '1'; }
}

async function saveSettings() {
const byline = document.getElementById('s-byline')?.value?.trim() || 'By the Theme Park Co-Pilot Team';
const postsPerPage = parseInt(document.getElementById('s-posts-per-page')?.value) || 30;
const readTimeMode = appSettings.readTimeMode || 'auto';
const settings = { byline, readTimeMode, postsPerPage };
appSettings = settings;
try {
const r = await fetch(API_BASE + '/api/blog-settings', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify(settings)
});
if (r.ok) {
const savedEl = document.getElementById('settings-saved');
if (savedEl) { savedEl.style.opacity = '1'; setTimeout(() => { savedEl.style.opacity = '0'; }, 2000); }
} else { showToast('Settings save failed', 'error'); }
} catch(e) { showToast('Settings save failed', 'error'); }
}
function showView(v) {
sessionStorage.setItem('admin_current_view', v);
['posts','editor','images','settings','batch','drafts'].forEach(id => {
const el = document.getElementById(id + '-view');
if (el) el.style.display = 'none';
});
document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
const viewMap = {
posts: { el: 'posts-view', nav: 'nav-posts' },
editor: { el: 'editor-view', nav: 'nav-new' },
images: { el: 'images-view', nav: 'nav-images', cb: loadImagesInline },
settings: { el: 'settings-view', nav: 'nav-settings' },
batch: { el: 'batch-view', nav: 'nav-batch' },
drafts: { el: 'drafts-view', nav: 'nav-drafts', cb: renderDraftsList }
};
const vm = viewMap[v];
if (vm) {
document.getElementById(vm.el).style.display = 'block';
document.getElementById(vm.nav)?.classList.add('active');
if (vm.cb) vm.cb();
}
}
// ============================================================
// POSTS LIST
// ============================================================
var cachedPosts = [];
// ============================================================
// OPTIMISTIC LIST OVERLAY (guardrails: Claude msgs #444/#448)
// The blob store's reads lag its writes (up to ~2 min), so a list
// re-fetch right after a confirmed mutation can serve pre-action
// state and make the admin contradict an action it just confirmed.
// This session-only overlay records ONLY the outcomes that
// confirmed mutation responses name; list loads apply it over the
// fetched data. Reconciliation is by CONTENT, never by refresh:
// an upsert retires only when a fetch shows the same published
// state at the same or a newer updatedAt, a remove retires only
// when a fetch omits the slug - and every record retires when it
// ages past the TTL (just beyond the store's visibility window),
// whatever the fetch says. A fresh page load starts with an empty
// overlay (pure store data). Never persisted (no web storage).
// ============================================================
const OPTIMISTIC_TTL_MS = 150000;
const optimisticOverlay = new Map();

function optimisticUpsert(slug, entry) {
  if (!slug || !entry) return;
  optimisticOverlay.set(slug, { kind: 'upsert', entry: entry, recordedAt: Date.now() });
}
function optimisticRemove(slug) {
  if (!slug) return;
  optimisticOverlay.set(slug, { kind: 'remove', recordedAt: Date.now() });
}
function isOptimistic(slug) {
  return optimisticOverlay.has(slug);
}
// Subtle marker for rows currently backed by the overlay: the
// write is confirmed, the store read has not caught up yet. One
// small muted dot per row, however many rows are pending.
function optimisticMark(slug) {
  return isOptimistic(slug) ? '<span title="Just saved - catching up" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#B8C4C6;margin-right:6px;vertical-align:middle"></span>' : '';
}
// Actions container for a row: a pending-remove row's buttons are
// rendered inert - the row stays visible, its actions do not work.
function postActionsOpen(post, stopProp) {
  const open = '<div class="post-actions"' + (stopProp ? ' onclick="event.stopPropagation()"' : '');
  return (post && post._pendingRemove) ? open + ' style="pointer-events:none;opacity:.55">' : open + '>';
}
// Index-shaped entry built from the post data the client already
// holds (the field set blog-save writes into the index), merged
// over the post's current list entry so store-only fields the
// client does not carry (e.g. bodySnippet) survive the overlay.
function toOptimisticEntry(post, existing) {
  const base = existing || {};
  return {
    ...base,
    slug: post.slug,
    title: post.title,
    park: post.park,
    category: post.category,
    tagLabel: post.tagLabel,
    heroImage: post.heroImage,
    heroAlt: post.heroAlt,
    intro: post.intro,
    readTime: post.readTime,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    published: post.published,
    scheduledAt: post.scheduledAt || null,
    tags: post.tags || []
  };
}
// Apply the overlay to a freshly fetched list. Pure apart from
// retiring overlay records per the rules above: returns a new
// array; the store's data is used verbatim for every slug the
// overlay does not name. `now` is injectable for tests.
function applyOptimisticOverlay(fetchedEntries, overlay, now) {
  const fetched = Array.isArray(fetchedEntries) ? fetchedEntries : [];
  if (!overlay || overlay.size === 0) return fetched.slice();
  const t = (typeof now === 'number') ? now : Date.now();
  const bySlug = new Map();
  fetched.forEach(function(e) { if (e && e.slug) bySlug.set(e.slug, e); });
  const result = fetched.slice();
  overlay.forEach(function(rec, slug) {
    // Aged out: the optimistic belief had its window; the store's
    // version is the truth now, whatever it says.
    if (t - (rec.recordedAt || 0) > OPTIMISTIC_TTL_MS) { overlay.delete(slug); return; }
    const storeEntry = bySlug.get(slug);
    if (rec.kind === 'remove') {
      // Confirmed once the fetch omits the slug.
      if (!storeEntry) { overlay.delete(slug); return; }
      // Unconfirmed: keep the row VISIBLE but flagged pending-
      // remove (renderers grey it, strike the title, inert the
      // actions) - hiding a post whose delete secretly failed
      // would leave the operator unable to notice.
      const rIdx = result.findIndex(function(e) { return e.slug === slug; });
      if (rIdx >= 0) result[rIdx] = Object.assign({}, storeEntry, { _pendingRemove: true });
      return;
    }
    // kind === 'upsert': retires only on a content match (same
    // published state, store updatedAt at or past the confirmed
    // write) - never merely because a refresh happened.
    if (storeEntry && storeEntry.published === rec.entry.published &&
        String(storeEntry.updatedAt || '') >= String(rec.entry.updatedAt || '')) {
      overlay.delete(slug);
      return;
    }
    const uIdx = result.findIndex(function(e) { return e.slug === slug; });
    if (uIdx >= 0) result[uIdx] = rec.entry; else result.push(rec.entry);
  });
  return result;
}

async function loadPosts() {
  try {
    const r = await fetch(API_BASE + '/api/blog-admin-index', { headers: { 'x-admin-key': token } });
    const fetchedPosts = await r.json();
    allPosts = Array.isArray(fetchedPosts) ? applyOptimisticOverlay(fetchedPosts, optimisticOverlay) : [];
    cachedPosts = allPosts;
    try { const fr = await fetch(API_BASE + '/api/blog-feature'); if (fr.ok) { const fd = await fr.json(); featuredSlug = fd.featuredSlug || null; featuredKnown = true; } else { featuredKnown = false; } } catch(e) { featuredKnown = false; }
  try {
    const pr = await fetch(API_BASE + '/api/blog-pins');
    if (pr.ok) {
      const pd = await pr.json();
      if (pinnedSlugs.length === 0) {
        pinnedSlugs = pd.pins || [];
      }
      console.log('pinnedSlugs loaded:', pinnedSlugs);
    } else {
      console.error('blog-pins fetch failed:', pr.status);
    }
  } catch(e) {
    console.error('blog-pins fetch error:', e.message);
    pinnedSlugs = [];
  }
    renderPostList(allPosts.filter(p => p.published === true));
    renderDraftsSidebar(allPosts);
    document.getElementById('posts-badge').textContent = allPosts.filter(p => p.published === true).length; document.getElementById('drafts-badge').textContent = allPosts.filter(p => !p.published).length;

  } catch(e) { showToast('Failed to load posts', 'error'); }
}
function renderDraftsSidebar(posts) {
const drafts = posts.filter(p => !p.published);
const badgeEl = document.getElementById('drafts-badge');
if (badgeEl) badgeEl.textContent = drafts.length;
window._allDrafts = drafts;
}

function renderPostList(posts) {
const table = document.getElementById('posts-table');
const q = "'";
const maxPins = 12;
const pinnedSlugSet = new Set(pinnedSlugs);
const featuredPost = posts.find(p => p.slug === featuredSlug) || null;
const pinnedPosts = pinnedSlugs.map(slug => posts.find(p => p.slug === slug)).filter(p => p && p.slug !== featuredSlug);
const unpinnedPosts = posts.filter(p => !pinnedSlugSet.has(p.slug) && p.slug !== featuredSlug).sort((a,b) => new Date(b.publishedAt||0) - new Date(a.publishedAt||0));

// Section 0: Featured Post
let featuredSection = '';
if (featuredPost) {
const fp = featuredPost;
const fpParkCls = fp.park === 'dl' ? 'park-dl' : fp.park === 'wdw' ? 'park-wdw' : fp.park === 'uni' ? 'park-uni' : 'park-other';
const fpParkLabel = fp.park === 'dl' ? 'Disneyland' : fp.park === 'wdw' ? 'Walt Disney World' : fp.park === 'uni' ? 'Universal' : (fp.park || '');
const fpDate = fp.publishedAt ? new Date(fp.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
featuredSection = '<div style="background:#FFF8E8;border-radius:10px 10px 0 0;padding:12px 16px;margin-bottom:2px">' +
'<span style="font-weight:700;color:#92400E;font-size:14px">Featured Post</span>' +
'</div>' +
'<div class="post-row"' + (fp._pendingRemove ? ' style="background:#FFFBF0;border-left:3px solid #ECA050;opacity:.55">' : ' onclick="openPost(' + q + fp.slug + q + ')" style="background:#FFFBF0;border-left:3px solid #ECA050">') +
'<img class="post-thumb" src="' + (fp.heroImage||'') + '" alt="">' +
'<span class="post-title-cell">' + optimisticMark(fp.slug) + (fp._pendingRemove ? '<span style="text-decoration:line-through">' : '') + escHtml(fp.title||'Untitled') + (fp._pendingRemove ? '</span>' : '') + '</span>' +
'<span class="park-pill ' + fpParkCls + '">' + fpParkLabel + '</span>' +
'<span class="post-date">' + fpDate + '</span>' +
'<span style="background:#F59E0B;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;margin-right:4px">FEATURED</span>' +
postActionsOpen(fp, true) +
'<button type="button" class="btn-edit" onclick="featurePost(' + q + fp.slug + q + ')">Unfeature</button>' +
'<button type="button" class="btn-edit" onclick="openPost(' + q + fp.slug + q + ')">Edit</button>' +
'<button type="button" class="btn-del" onclick="quickDelete(' + q + fp.slug + q + ')">Delete</button>' +
'</div></div>';
}

const pinnedCount = pinnedPosts.length;
const totalPosts = posts.length;
let pinnedHeader = '<div style="background:#0A4840;border-radius:10px 10px 0 0;padding:12px 16px;display:flex;align-items:center;gap:10px;margin-bottom:2px">' +
'<span style="font-weight:700;color:#E0F5EE;font-size:14px">Pinned Posts</span>' +
'<span style="background:#1A6860;color:#7FFFD4;font-size:11px;font-weight:700;padding:2px 8px;border-radius:100px">' + pinnedCount + ' of ' + maxPins + '</span>' +
'</div>';
let pinnedRows = '';
if (pinnedPosts.length === 0) {
pinnedRows = '<div style="background:rgba(20,90,80,0.15);border:1px dashed rgba(127,255,212,0.2);border-radius:0 0 10px 10px;padding:20px;text-align:center;color:#8AACAE;font-size:13px;margin-bottom:20px">No pinned posts yet. Pin a post below to feature it at the top of the blog.</div>';
} else {
pinnedRows = '<div style="background:rgba(20,90,80,0.12);border:1px solid rgba(127,255,212,0.15);border-radius:0 0 10px 10px;margin-bottom:20px">' +
pinnedPosts.map((p, pinIdx) => {
const parkCls = p.park === 'dl' ? 'park-dl' : p.park === 'wdw' ? 'park-wdw' : 'park-both';
const parkLabel = p.park === 'dl' ? 'Disneyland' : p.park === 'wdw' ? 'WDW' : 'Both';
const date = p.publishedAt ? new Date(p.publishedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
const isFirst = pinIdx === 0;
const isLast = pinIdx === pinnedPosts.length - 1;
return '<div class="post-row"' + (p._pendingRemove ? ' style="border-left:3px solid #1A6860;opacity:.55">' : ' onclick="openPost(' + q + p.slug + q + ')" style="border-left:3px solid #1A6860">') +
'<img class="post-thumb" src="' + (p.heroImage||'') + '" alt="" loading="lazy" onerror="this.src=' + q + q + '">' +
'<span class="post-title-cell">' + optimisticMark(p.slug) + (p._pendingRemove ? '<span style="text-decoration:line-through">' : '') + escHtml(p.title||'Untitled') + (p._pendingRemove ? '</span>' : '') + ' <span style="font-size:11px;color:#F59E0B" title="Pinned #' + (pinIdx+1) + '">&#128204;</span></span>' +
'<span class="park-pill ' + parkCls + '">' + parkLabel + '</span>' +
'<span class="post-date">' + date + '</span>' +
postActionsOpen(p, true) +
'<button type="button" class="btn-edit btn-pin-move" title="Move up" onclick="event.stopPropagation();movePinUp(' + q + p.slug + q + ')" ' + (isFirst ? 'disabled style="opacity:0.3"' : '') + '>&#9650;</button>' +
'<button type="button" class="btn-edit btn-pin-move" title="Move down" onclick="event.stopPropagation();movePinDown(' + q + p.slug + q + ')" ' + (isLast ? 'disabled style="opacity:0.3"' : '') + '>&#9660;</button>' +
'<button type="button" class="btn-edit" style="color:#F59E0B;font-weight:bold" title="Unpin this post" onclick="togglePin(' + q + p.slug + q + ')">Unpin</button>' +
'<button type="button" class="btn-edit" onclick="openPost(' + q + p.slug + q + ')">Edit</button>' +
'</div></div>';
}).join('') +
'</div>';
}

let allPostsHeader = '<div style="margin-bottom:8px;padding:8px 0;border-bottom:1px solid rgba(7,30,37,0.1)">' +
'<span style="font-weight:700;color:#071E25;font-size:14px">All Posts</span>' +
'</div>';

let allRows = '';
if (unpinnedPosts.length === 0) {
allRows = '<div style="text-align:center;color:#8AACAE;padding:40px;font-size:14px">No posts yet.</div>';
} else {
const atLimit = pinnedSlugs.length >= maxPins;
allRows = unpinnedPosts.map(p => {
const parkCls = p.park === 'dl' ? 'park-dl' : p.park === 'wdw' ? 'park-wdw' : 'park-both';
const parkLabel = p.park === 'dl' ? 'Disneyland' : p.park === 'wdw' ? 'WDW' : 'Both';
let statusCls, statusLabel;
if (p.published) { statusCls = 'status-published'; statusLabel = 'Published'; }
else if (p.scheduledAt) { statusCls = 'status-scheduled'; statusLabel = 'Scheduled'; }
else { statusCls = 'status-draft'; statusLabel = 'Draft'; }
const date = p.publishedAt ? new Date(p.publishedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
const pinDisabled = atLimit ? 'disabled title="Maximum pins reached ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ unpin a post above first" style="opacity:0.4;cursor:not-allowed"' : 'title="Pin to top of blog"';
return '<div class="post-row"' + (p._pendingRemove ? ' style="opacity:.55">' : ' onclick="openPost(' + q + p.slug + q + ')">') +
'<img class="post-thumb" src="' + (p.heroImage||'') + '" alt="" loading="lazy" onerror="this.src=' + q + q + '">' +
'<span class="post-title-cell">' + optimisticMark(p.slug) + (p._pendingRemove ? '<span style="text-decoration:line-through">' : '') + escHtml(p.title||'Untitled') + (p._pendingRemove ? '</span>' : '') + '</span>' +
'<span class="park-pill ' + parkCls + '">' + parkLabel + '</span>' +
'<span class="status-pill ' + statusCls + '">' + statusLabel + '</span>' +
'<span class="post-date">' + date + '</span>' +
postActionsOpen(p, true) +
'<button type="button" class="btn-edit" onclick="openPost(' + q + p.slug + q + ')">Edit</button>' +
'<button type="button" class="btn-feat" onclick="featurePost(' + q + p.slug + q + ')">' + (featuredSlug === p.slug ? '&#128204;' : 'Feature') + '</button>' +
'<button type="button" class="btn-edit" ' + pinDisabled + ' onclick="togglePin(' + q + p.slug + q + ')">&#128204; Pin</button>' +
'<button type="button" class="btn-del" onclick="quickDelete(' + q + p.slug + q + ')">Delete</button>' +
'</div></div>';
}).join('');
}


table.innerHTML = (featuredKnown ? '' : '<div style="background:#FDECEC;border-radius:10px;padding:12px 16px;margin-bottom:10px;color:#7A1F1F">Featured status could not be loaded — unfeaturing is disabled until the list reloads successfully.</div>') + featuredSection + pinnedHeader + pinnedRows + allPostsHeader + allRows;
}
function renderDraftsList() {
const table = document.getElementById('drafts-table');
if (!table) return;
const drafts = (window._allDrafts || allPosts.filter(p => !p.published)).sort((a, b) => {
if (a.scheduledAt && b.scheduledAt) return new Date(a.scheduledAt) - new Date(b.scheduledAt);
if (a.scheduledAt) return -1;
if (b.scheduledAt) return 1;
return 0;
});
if (!drafts.length) {
table.innerHTML = '<div style="text-align:center;color:#8AACAE;padding:40px;font-size:14px">No drafts yet.</div>';
return;
}
const q = "'";
table.innerHTML = drafts.map(p => {
const parkCls = p.park === 'dl' ? 'park-dl' : p.park === 'wdw' ? 'park-wdw' : 'park-both';
const parkLabel = p.park === 'dl' ? 'Disneyland' : p.park === 'wdw' ? 'WDW' : 'Both';
const statusCls = p.scheduledAt ? 'status-scheduled' : 'status-draft';
const statusLabel = p.scheduledAt ? 'Scheduled' : 'Draft';
const date = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
return '<div class="post-row"' + (p._pendingRemove ? ' style="opacity:.55">' : '>') +
'<img class="post-thumb" src="' + (p.heroImage||'') + '" alt="" loading="lazy" onerror="this.src=' + q + q + '">' +
'<span class="post-title-cell">' + optimisticMark(p.slug) + (p._pendingRemove ? '<span style="text-decoration:line-through">' : '') + escHtml(p.title||'Untitled') + (p._pendingRemove ? '</span>' : '') + '</span>' +
'<span class="park-pill ' + parkCls + '">' + parkLabel + '</span>' +
'<span class="status-pill ' + statusCls + '">' + statusLabel + '</span>' +
'<span class="post-date">' + date + '</span>' +
postActionsOpen(p, false) +
'<button type="button" class="btn-edit" onclick="openPost(' + q + p.slug + q + ')">Edit</button>' +
'<button type="button" class="btn-edit" style="color:#22A855" onclick="publishDraft(' + q + p.slug + q + ')">Publish</button>' +
'<button type="button" class="btn-edit" style="color:#D97706" onclick="openPost(' + q + p.slug + q + ');setTimeout(openScheduleModal,400)">Schedule</button>' +
'<button type="button" class="btn-del" onclick="quickDelete(' + q + p.slug + q + ', ' + q + 'drafts' + q + ')">Delete</button>' +
'</div></div>';
}).join('');
}

function filterDrafts(q) {
if (!q) { renderDraftsList(); return; }
const lq = q.toLowerCase();
const filtered = (window._allDrafts || allPosts.filter(p => !p.published)).filter(p =>
((p.title||'').toLowerCase().includes(lq) || (p.slug||'').toLowerCase().includes(lq))
);
window._allDrafts = filtered;
renderDraftsList();
window._allDrafts = allPosts.filter(p => !p.published);
}

async function publishDraft(slug) {
try {
const r = await fetch(API_BASE + '/api/blog-admin-post?slug=' + encodeURIComponent(slug), { headers: { 'x-admin-key': token } });
if (!r.ok) { showToast('Could not load draft', 'error'); return; }
const post = await r.json();
post.published = true;
// Publish-date rule (Beau, Oct 16, 2026): a draft's date is when it
// goes live, never when it was created. This path IS a transition by
// construction (Publish clicked on a Drafts-list item), so stamp
// unconditionally. The server (blog-save + api/lib/publish-date.js)
// owns the stored value; this client stamp exists so the PR #54
// optimistic overlay, which builds its entry from this object, sorts
// by the go-live date during the visibility window instead of a
// stale draft date.
post.publishedAt = new Date().toISOString();
post.updatedAt = new Date().toISOString();
const saveR = await fetch(API_BASE + '/api/blog-save', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify(post)
});
const data = await saveR.json();
if (saveR.ok && data.success) {
optimisticUpsert(data.slug || slug, toOptimisticEntry(post, allPosts.find(function(p) { return p.slug === slug; })));
showToast('Published \u2713', 'success');
await loadPosts();
renderDraftsList();
} else { showToast(data.error || 'Publish failed', 'error'); }
} catch(e) { showToast('Publish failed', 'error'); }
}

function filterPosts(q) {
if (!q) { renderPostList(allPosts); return; }
const lq = q.toLowerCase();
renderPostList(allPosts.filter(p => p.published === true && ((p.title||'').toLowerCase().includes(lq) || (p.slug||'').toLowerCase().includes(lq))));
}
// ============================================================
// FEATURE POST
// ============================================================
async function featurePost(slug) {
  try {
    // Revalidate before writing: the toggle must be computed from the
    // server's CURRENT featured slug, not this page's possibly-stale belief.
    // The accident this prevents: on a stale page (another tab changed the
    // featured post), clicking to unfeature X used to send slug:null and
    // unfeature whatever was actually featured. Revalidation closes the
    // wide staleness window; the blob store's read-after-write lag means a
    // change only seconds old may still be invisible — the same residual
    // the server-side index updater carries.
    let current = null;
    let revalidated = false;
    try {
      const fr = await fetch(API_BASE + '/api/blog-feature');
      if (fr.ok) { const fd = await fr.json(); current = fd.featuredSlug || null; revalidated = true; }
    } catch(e) { /* revalidation failed: state is unknown, handled below */ }
    if (revalidated) {
      if (current !== featuredSlug) {
        await loadPosts();
        showToast('Featured post was changed elsewhere — list refreshed, your click was not applied.', 'error');
        return;
      }
      featuredKnown = true;
    } else {
      featuredKnown = false;
      if (featuredSlug === slug) {
        // The click intends an unfeature, but the current state can't be
        // verified — refuse the null write rather than guess.
        showToast('Could not verify the current featured post — unfeature cancelled. Reload the page and try again.', 'error');
        return;
      }
      // Featuring a slug while unknown is safe (worst case it sets what is
      // already set); only the null write is refused. Fall through.
    }
    const isCurrentlyFeatured = featuredSlug === slug;
    const newSlug = isCurrentlyFeatured ? null : slug;
    if (newSlug === null && !featuredKnown) {
      showToast('Could not verify the current featured post — unfeature cancelled. Reload the page and try again.', 'error');
      return;
    }
    const res = await fetch(API_BASE + '/api/blog-feature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
      body: JSON.stringify({ slug: newSlug })
    });
    const data = await res.json();
    if (data.success) {
      featuredSlug = newSlug;
      featuredKnown = true;
      showToast(newSlug ? 'Featured post updated' : 'Post unfeatured', 'success');
      await loadPosts();
    } else {
      showToast('Failed to update featured post', 'error');
    }
  } catch(e) {
    console.error('featurePost error:', e);
    showToast('Error: ' + e.message, 'error');
  }
}

// ============================================================
// PINNED POSTS
// ============================================================
async function togglePin(slug) {
  const idx = pinnedSlugs.indexOf(slug);
  if (idx !== -1) {
    pinnedSlugs.splice(idx, 1);
  } else {
    if (pinnedSlugs.length >= 12) { alert('You\'ve reached the maximum number of pinned posts (12). Please unpin a post before pinning a new one.'); return; }
    pinnedSlugs.push(slug);
  }
  await savePins();
  renderPostList(allPosts.filter(p => p.published === true));
}

async function movePinUp(slug) {
  const idx = pinnedSlugs.indexOf(slug);
  if (idx <= 0) return;
  pinnedSlugs.splice(idx - 1, 0, pinnedSlugs.splice(idx, 1)[0]);
  await savePins();
  renderPostList(allPosts.filter(p => p.published));
}

async function movePinDown(slug) {
  const idx = pinnedSlugs.indexOf(slug);
  if (idx < 0 || idx >= pinnedSlugs.length - 1) return;
  pinnedSlugs.splice(idx + 1, 0, pinnedSlugs.splice(idx, 1)[0]);
  await savePins();
  renderPostList(allPosts.filter(p => p.published));
}

async function savePins() {
  try {
    await fetch(API_BASE + '/api/blog-pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
      body: JSON.stringify({ pins: pinnedSlugs })
    });
  } catch(e) {
    console.error('savePins error:', e);
  }
}

function formatScheduledDate(iso) {
try {
const d = new Date(iso);
return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + ' ' +
d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
} catch(e) { return iso; }
}
async function openPost(slug) {
try {
const r = await fetch(API_BASE + '/api/blog-admin-post?slug=' + encodeURIComponent(slug), { headers: { 'x-admin-key': token } });
if (!r.ok) { showToast('Could not load post', 'error'); return; }
const post = await r.json();
currentPost = post;
populateEditor(post);
isDirty = false;
document.getElementById('btn-delete-post').style.display = 'block';
// Fix 3: Update back button label based on post type
const backLabelEl = document.getElementById('editor-back-label');
if (backLabelEl) backLabelEl.innerHTML = post.published ? '&larr; Back to Live Posts' : '&larr; Back to Drafts';
// Show schedule button only for drafts
const schedulBtn = document.getElementById('btn-schedule');
if (!post.published) {
schedulBtn.style.display = 'block';
schedulBtn.textContent = post.scheduledAt ? ('Scheduled - ' + formatScheduledDate(post.scheduledAt)) : 'Schedule';
schedulBtn.style.color = post.scheduledAt ? '#D97706' : '';
} else {
schedulBtn.style.display = 'none';
}
const publishBtn = document.getElementById('btn-publish'); if (post.published) { publishBtn.textContent = 'Update'; publishBtn.onclick = updatePost; } else { publishBtn.textContent = 'Go Live'; publishBtn.onclick = goLive; } sessionStorage.setItem('admin_current_view', 'editor');
sessionStorage.setItem('admin_current_post', slug);
showView('editor');
} catch(e) { showToast('Failed to load post', 'error'); }
}
function clearEditor() {
document.getElementById('f-title').value = '';
document.getElementById('f-slug').value = '';
document.getElementById('f-park').value = 'dl';
document.getElementById('f-meta').value = '';
document.getElementById('f-intro').value = '';
document.getElementById('f-readtime').value = '5';
document.getElementById('f-hero-url').value = '';
document.getElementById('f-hero-alt').value = '';
document.getElementById('f-published').checked = false;
document.getElementById('status-label').textContent = 'Draft';
document.getElementById('f-cta-type').value = 'dl';
document.getElementById('hero-preview').src = '';
document.getElementById('faq-list').innerHTML = '';
document.getElementById('related-list').innerHTML = '';
const tagsEl = document.getElementById('f-tags');
if (tagsEl) tagsEl.value = '';
if (quill) quill.setContents([]);
resetPhotoPanel();
setFocal('center');
applyReadTimeModeToField();
updatePreviews();
}
function newPost() {
currentPost = null;
isDirty = false;
sessionStorage.removeItem('admin_current_post');
clearEditor();
document.getElementById('btn-delete-post').style.display = 'none'; const publishBtn = document.getElementById('btn-publish'); publishBtn.textContent = 'Go Live'; publishBtn.onclick = goLive;
const schedulBtn = document.getElementById('btn-schedule');
if (schedulBtn) schedulBtn.style.display = 'none';
const backLabelEl = document.getElementById('editor-back-label');
if (backLabelEl) backLabelEl.innerHTML = '&larr; Back to Posts';
showView('editor');
}

function applyReadTimeModeToField() {
const rtInput = document.getElementById('f-readtime');
if (!rtInput) return;
const isAuto = appSettings.readTimeMode === 'auto';
rtInput.disabled = isAuto;
rtInput.style.opacity = isAuto ? '0.6' : '1';
}

function populateEditor(post) {
document.getElementById('f-title').value = post.title || '';
document.getElementById('f-slug').value = post.slug || '';
document.getElementById('f-park').value = post.park || 'dl';
document.getElementById('f-meta').value = post.metaDescription || '';
document.getElementById('f-intro').value = post.intro || '';
document.getElementById('f-readtime').value = post.readTime || '5';
document.getElementById('f-hero-url').value = post.heroImage || '';
document.getElementById('f-hero-alt').value = post.heroAlt || '';
document.getElementById('f-published').checked = !!post.published;
document.getElementById('status-label').textContent = post.published ? 'Published' : 'Draft';
document.getElementById('f-cta-type').value = (post.cta && post.cta.type) || 'dl';
document.getElementById('hero-preview').src = post.heroImage || '';
document.getElementById('hero-preview').style.objectPosition = post.heroFocal || 'center';
const focal = post.heroFocal || 'center';
document.querySelectorAll('.focal-dot').forEach(d => { d.classList.toggle('selected', d.dataset.focal === focal); });
if (quill) {
if (post.body) { quill.root.innerHTML = post.body; }
else { quill.setContents([]); }
}
initPhotoPanel();
const faqList = document.getElementById('faq-list');
faqList.innerHTML = '';
(post.faqs || []).forEach(faq => addFaqItem(faq.q, faq.a));
const relList = document.getElementById('related-list');
relList.innerHTML = '';
(post.related || []).forEach(rel => addRelatedRow(rel.slug));
document.getElementById('f-tags').value = (post.tags || []).join(', ');
applyReadTimeModeToField();
onMetaChange();
updatePreviews();
}

// === PHOTO PANEL START ===
// Photo reorder panel (PRs #59/#61/#62). Design approved by Claude (security
// thread, Oct 14–15, 2026): a photo moves ONLY as a whole <p> whose sole
// content is one <img> (strict separability) — image+text paragraphs and
// photos in figure/div wrappers are LOCKED and hold their position. A photo
// locked ONLY for sharing its <p> with text can be UNLOCKED (PR #61): the
// <img> is lifted into its own paragraph; wrapper-locked photos stay locked.
// PR #62 (save-on-Update): the panel has NO save of its own. Moves and
// unlocks are STAGED locally; when the editor saves (Update / Go Live / Save
// Draft — all funnel through savePost), the staged changes are re-applied to
// the CURRENT editor body and written in that same save — one commit point,
// never two write paths. Staged moves re-apply by photo identity + position
// among the non-photo blocks (text-independent); staged unlocks carry a
// host-paragraph guard (the host's before/after text recorded at stage time)
// and REFUSE the save, naming the photo, if that paragraph changed in the
// editor meanwhile. Structural divergence (blocks added/removed in the
// editor) also refuses, loudly, with Revert staged changes as the escape.
// Normalization (collapse empty-paragraph runs to one) happens ONLY when
// staged changes commit — never on ordinary editor saves. An indicator next
// to the publish button shows "N photo changes staged" so a commit never
// surprises. Invariants (visible text + photo set) are checked against the
// editor body before anything is written.
var ppState = null; // { originalBody, blocks: [html], dirty, unsupported, unlocks: [{key, src, splits, beforeHard, afterHard}] }

function ppParseRoot(bodyHtml) {
const doc = new DOMParser().parseFromString('<div id="pp-root">' + (bodyHtml || '') + '</div>', 'text/html');
return doc.getElementById('pp-root');
}
function ppBlocksFromBody(bodyHtml) {
const root = ppParseRoot(bodyHtml);
let stray = false;
root.childNodes.forEach(n => { if (n.nodeType === 3 && n.textContent.trim() !== '') stray = true; });
const blocks = [];
[...root.children].forEach(el => blocks.push(el.outerHTML));
return { blocks, stray };
}
function ppBlockEl(blockHtml) {
const d = document.createElement('div');
d.innerHTML = blockHtml;
return d.firstElementChild;
}
function ppIsSpacerEl(el) {
return !!el && el.tagName === 'P' && el.textContent.trim() === '' && !el.querySelector('img,iframe,video,table');
}
// kind: 'movable' (a <p> whose ONLY element child is one <img>, no text),
// 'locked' (contains an <img> but not strictly separable), 'other'.
function ppBlockInfo(blockHtml) {
const el = ppBlockEl(blockHtml);
if (!el) return { kind: 'other', src: null, spacer: false };
const spacer = ppIsSpacerEl(el);
const imgs = el.querySelectorAll('img');
if (imgs.length === 0) return { kind: 'other', src: null, spacer };
const src = imgs[0].getAttribute('src') || '';
let movable = false;
if (el.tagName === 'P' && imgs.length === 1 && el.children.length === 1 && el.children[0].tagName === 'IMG' && el.textContent.trim() === '') movable = true;
// Locked split: 'text' = the photo's only lock is sharing its <p> with text,
// with the <img> a direct child of the <p> (unlockable, PR #61). Anything
// else — non-<p> block, nested <img>, several photos — is 'wrapped' and
// stays locked.
let lockReason = null, unlockable = false;
if (!movable) {
lockReason = 'wrapped';
if (el.tagName === 'P' && imgs.length === 1) {
el.childNodes.forEach(n => { if (n.nodeType === 1 && n.tagName === 'IMG') { lockReason = 'text'; unlockable = true; } });
}
}
return { kind: movable ? 'movable' : 'locked', src, spacer: false, alt: imgs[0].getAttribute('alt') || '', lockReason, unlockable };
}
function ppHardText(html) {
const d = document.createElement('div');
d.innerHTML = html || '';
return d.textContent.replace(/\s+/g, '');
}
function ppImgList(html) {
const d = document.createElement('div');
d.innerHTML = html || '';
return [...d.querySelectorAll('img')].map(i => i.getAttribute('src') || '');
}
function ppCountEmpties(blocks) {
return blocks.reduce((n, b) => n + (ppBlockInfo(b).spacer ? 1 : 0), 0);
}
// Nearest index from idx in direction dir holding a NON-spacer, NON-image
// block (a text/heading/list anchor a photo can trade places with), or -1.
function ppAnchorIndex(blocks, idx, dir) {
for (let j = idx + dir; j >= 0 && j < blocks.length; j += dir) {
const info = ppBlockInfo(blocks[j]);
if (!info.spacer && info.kind === 'other') return j;
}
return -1;
}
function ppSwapWithAnchor(blocks, idx, dir) {
const j = ppAnchorIndex(blocks, idx, dir);
if (j < 0) return false;
const t = blocks[idx]; blocks[idx] = blocks[j]; blocks[j] = t;
return true;
}
function ppMoveToPhoto(blocks, fromIdx, targetIdx, after) {
if (fromIdx === targetIdx) return false;
const item = blocks.splice(fromIdx, 1)[0];
let ins = targetIdx;
if (fromIdx < targetIdx) ins = targetIdx - 1;
if (after) ins += 1;
blocks.splice(ins, 0, item);
return true;
}
function ppFragmentHasContent(el) {
if (el.textContent.trim() !== '') return true;
return !!el.querySelector('a,strong,em,u,s,sub,sup,iframe,video,table,ul,ol,span');
}
function ppCloneP(host, nodes) {
const p = document.createElement('p');
host.getAttributeNames().forEach(a => p.setAttribute(a, host.getAttribute(a)));
nodes.forEach(n => p.appendChild(n));
return p;
}
// Split a 'text'-locked block into [text-before?] + [photo <p>] + [text-after?]
// by lifting the <img> into its own paragraph (attributes preserved by moving
// the actual nodes). Returns { parts, splits } — splits = meaningful content
// follows the photo — or null when the block is not unlockable.
function ppSplitLocked(blockHtml) {
const el = ppBlockEl(blockHtml);
if (!el || el.tagName !== 'P') return null;
if (el.querySelectorAll('img').length !== 1) return null;
let img = null, seen = false;
const before = [], after = [];
[...el.childNodes].forEach(n => {
if (n.nodeType === 1 && n.tagName === 'IMG' && !seen) { img = n; seen = true; return; }
(seen ? after : before).push(n);
});
if (!img) return null; // the <img> is nested inside another element: wrapped, stays locked
const beforeP = ppCloneP(el, before);
const afterP = ppCloneP(el, after);
const hasBefore = ppFragmentHasContent(beforeP);
const hasAfter = ppFragmentHasContent(afterP);
const parts = [];
if (hasBefore) parts.push(beforeP.outerHTML);
parts.push(ppCloneP(el, [img]).outerHTML);
if (hasAfter) parts.push(afterP.outerHTML);
return { parts, splits: hasAfter, beforeHard: ppHardText(beforeP.outerHTML), afterHard: ppHardText(afterP.outerHTML) };
}
// Photo identity: src + occurrence among photo blocks (the same image can
// legitimately appear twice in a post; index-based identity breaks the
// moment text is edited, src+occurrence survives it).
function ppPhotoKey(blocks, idx) {
const src = ppBlockInfo(blocks[idx]).src || '';
let occ = 0;
for (let j = 0; j < idx; j++) {
const b = ppBlockInfo(blocks[j]);
if (b.kind !== 'other' && (b.src || '') === src) occ++;
}
return src + '#' + occ;
}
function ppPhotoKeys(blocks) {
const keys = [];
blocks.forEach((b, i) => { if (ppBlockInfo(b).kind !== 'other') keys.push({ idx: i, key: ppPhotoKey(blocks, i), src: ppBlockInfo(b).src || '' }); });
return keys;
}
function ppDoUnlock(idx) {
if (!ppState) return;
const info = ppBlockInfo(ppState.blocks[idx]);
if (info.kind !== 'locked' || !info.unlockable) return;
const res = ppSplitLocked(ppState.blocks[idx]);
if (!res) return;
const key = ppPhotoKey(ppState.blocks, idx);
ppState.blocks.splice(idx, 1, ...res.parts);
ppState.unlocks.push({ key, src: info.src, splits: res.splits, beforeHard: res.beforeHard, afterHard: res.afterHard });
ppAfterChange();
ppNotice('ok', 'Photo unlocked — it is now its own paragraph and can be moved. The change is staged and saves when you press Update.');
}
function ppNormalize(blocks) {
const out = [];
let prevSpacer = false;
for (const b of blocks) {
const sp = ppBlockInfo(b).spacer;
if (sp && prevSpacer) continue;
out.push(b);
prevSpacer = sp;
}
return out;
}
// Returns a list of named violations (empty = pass). Text is compared with
// ALL whitespace stripped: spacer paragraphs and img-paragraph padding carry
// whitespace that is not visible text (proven in the Oct 15 cleanup snippets).
function ppCheckInvariants(oldBody, newBody) {
const v = [];
if (ppHardText(oldBody) !== ppHardText(newBody)) v.push('the visible text would change');
const a = ppImgList(oldBody).slice().sort(), b = ppImgList(newBody).slice().sort();
if (JSON.stringify(a) !== JSON.stringify(b)) v.push('the set of photos would change');
return v;
}
function ppFollowsLabel(blocks, idx) {
for (let j = idx - 1; j >= 0; j--) {
const info = ppBlockInfo(blocks[j]);
if (info.spacer) continue;
if (info.kind !== 'other') return 'After the previous photo';
const el = ppBlockEl(blocks[j]);
const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
if (!t) continue;
return (el.tagName === 'H2' || el.tagName === 'H3' ? 'Section: ' : 'After: ') + (t.length > 60 ? t.slice(0, 60) + '…' : t);
}
return 'Start of the post';
}
function ppEsc(s) {
return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function initPhotoPanel() {
const mount = document.getElementById('photo-panel');
if (!mount) return;
const body = quill ? quill.root.innerHTML : '';
const parsed = ppBlocksFromBody(body);
ppState = { originalBody: body, blocks: parsed.blocks, dirty: false, unsupported: parsed.stray, unlocks: [] };
ppRender();
ppUpdateIndicator();
}
function resetPhotoPanel() {
ppState = null;
const mount = document.getElementById('photo-panel');
if (mount) mount.innerHTML = '<div class="pp-empty">Open a post to reorder its photos.</div>';
ppUpdateIndicator();
}
function ppNotice(kind, msg) {
const n = document.getElementById('pp-notice');
if (!n) return;
n.className = 'pp-notice' + (kind ? ' pp-' + kind : '');
n.textContent = msg || '';
}
function ppRender() {
const mount = document.getElementById('photo-panel');
if (!mount || !ppState) return;
if (ppState.unsupported) {
mount.innerHTML = '<div class="pp-empty">This post\'s body has loose text outside any paragraph, a shape this panel can\'t safely reorder. Edit photos in the body editor above instead.</div>';
return;
}
const blocks = ppState.blocks;
const infos = blocks.map(ppBlockInfo);
const imgIdx = [];
infos.forEach((info, i) => { if (info.kind !== 'other') imgIdx.push(i); });
let html = '';
if (imgIdx.length === 0) {
html += '<div class="pp-empty">No photos in the body of this post. (The hero image is managed in the panel on the right.)</div>';
} else {
imgIdx.forEach(i => {
const info = infos[i];
const file = (info.src || '').split('/').pop();
if (info.kind === 'movable') {
const upOk = ppAnchorIndex(blocks, i, -1) >= 0;
const dnOk = ppAnchorIndex(blocks, i, 1) >= 0;
html += '<div class="pp-row" draggable="true" data-pp-row="' + i + '">'
+ '<span class="pp-drag" title="Drag to move">&#9776;</span>'
+ '<img class="pp-thumb" src="' + ppEsc(info.src) + '" alt="">'
+ '<div class="pp-meta"><div class="pp-follows">' + ppEsc(ppFollowsLabel(blocks, i)) + '</div>'
+ '<div class="pp-file">' + ppEsc(file) + '</div></div>'
+ '<div class="pp-btns">'
+ '<button type="button" class="pp-move-btn" data-pp-move="' + i + ':-1" ' + (upOk ? '' : 'disabled') + ' title="Move up">&#9650;</button>'
+ '<button type="button" class="pp-move-btn" data-pp-move="' + i + ':1" ' + (dnOk ? '' : 'disabled') + ' title="Move down">&#9660;</button>'
+ '</div></div>';
} else if (info.unlockable) {
html += '<div class="pp-row pp-locked" data-pp-row="' + i + '">'
+ '<span class="pp-drag" style="visibility:hidden">&#9776;</span>'
+ '<img class="pp-thumb" src="' + ppEsc(info.src) + '" alt="">'
+ '<div class="pp-meta"><div class="pp-follows">' + ppEsc(ppFollowsLabel(blocks, i)) + '</div>'
+ '<div class="pp-file">' + ppEsc(file) + '</div>'
+ '<span class="pp-badge">LOCKED — shares its paragraph with text; position held</span></div>'
+ '<div class="pp-btns"><button type="button" class="pp-unlock-btn" data-pp-unlock="' + i + '" title="Lift this photo out of its paragraph so it can be moved">Unlock photo</button></div></div>';
} else {
html += '<div class="pp-row pp-locked" data-pp-row="' + i + '">'
+ '<span class="pp-drag" style="visibility:hidden">&#9776;</span>'
+ '<img class="pp-thumb" src="' + ppEsc(info.src) + '" alt="">'
+ '<div class="pp-meta"><div class="pp-follows">' + ppEsc(ppFollowsLabel(blocks, i)) + '</div>'
+ '<div class="pp-file">' + ppEsc(file) + '</div>'
+ '<span class="pp-badge">LOCKED — inside a figure or link wrapper; position held (wrapped photos stay locked)</span></div></div>';
}
});
}
html += '<div class="pp-actions">'
+ '<button type="button" class="pp-revert-btn" id="pp-revert-btn" ' + (ppState.dirty ? '' : 'disabled') + '>Revert staged changes</button>'
+ '</div>'
+ '<div class="pp-notice" id="pp-notice"></div>'
+ '<div class="pp-status">' + (ppState.dirty ? 'Photo changes are staged — they save together with the post when you press Update (or Save Draft / Go Live).' : 'Photo order matches the saved post.') + '</div>';
mount.innerHTML = html;
// Wire controls (no inline handlers; CSP-friendly and testable).
mount.querySelectorAll('[data-pp-move]').forEach(btn => {
btn.addEventListener('click', () => {
const parts = btn.getAttribute('data-pp-move').split(':');
ppDoMove(parseInt(parts[0], 10), parseInt(parts[1], 10));
});
});
mount.querySelectorAll('[data-pp-unlock]').forEach(btn => {
btn.addEventListener('click', () => ppDoUnlock(parseInt(btn.getAttribute('data-pp-unlock'), 10)));
});
const rv = document.getElementById('pp-revert-btn');
if (rv) rv.addEventListener('click', ppRevertAll);
mount.querySelectorAll('[data-pp-row]').forEach(row => {
row.addEventListener('dragstart', e => {
const idx = parseInt(row.getAttribute('data-pp-row'), 10);
if (!ppState || ppBlockInfo(ppState.blocks[idx]).kind !== 'movable') { e.preventDefault(); return; }
e.dataTransfer.setData('text/plain', String(idx));
e.dataTransfer.effectAllowed = 'move';
});
row.addEventListener('dragover', e => {
e.preventDefault();
row.classList.add('pp-dragover');
});
row.addEventListener('dragleave', () => row.classList.remove('pp-dragover'));
row.addEventListener('drop', e => {
e.preventDefault();
row.classList.remove('pp-dragover');
const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
const target = parseInt(row.getAttribute('data-pp-row'), 10);
if (isNaN(from) || isNaN(target) || !ppState) return;
const rect = row.getBoundingClientRect();
const after = (e.clientY - rect.top) > rect.height / 2;
if (ppMoveToPhoto(ppState.blocks, from, target, after)) ppAfterChange();
});
});
}
function ppAfterChange() {
ppState.dirty = true;
markDirty();
ppRender();
ppUpdateIndicator();
}
function ppDoMove(idx, dir) {
if (!ppState) return;
if (ppSwapWithAnchor(ppState.blocks, idx, dir)) ppAfterChange();
}
function ppRevertAll() {
if (!ppState) return;
// Discard the staged changes: the panel re-syncs to the CURRENT editor body
// (which may hold unsaved text edits — those are the editor's, untouched).
const body = quill ? quill.root.innerHTML : ppState.originalBody;
const parsed = ppBlocksFromBody(body);
if (!parsed.stray) { ppState.blocks = parsed.blocks; ppState.unsupported = false; }
else { ppState.blocks = ppBlocksFromBody(ppState.originalBody).blocks; }
ppState.dirty = false;
ppState.unlocks = [];
ppRender();
ppUpdateIndicator();
ppNotice('ok', 'Staged photo changes discarded. The panel now matches the editor.');
}
// The block a photo follows, as text (or a sentinel) — used only for the
// staged-change COUNT shown in the UI, never for the commit itself.
function ppAnchorLabel(blocks, idx) {
for (let j = idx - 1; j >= 0; j--) {
const info = ppBlockInfo(blocks[j]);
if (info.spacer) continue;
if (info.kind !== 'other') return 'photo:' + (info.src || '');
return 'block:' + ppHardText(blocks[j]);
}
return 'START';
}
function ppStagedCount() {
if (!ppState || !ppState.dirty) return 0;
let n = (ppState.unlocks || []).length;
const orig = ppBlocksFromBody(ppState.originalBody).blocks;
const unlockedKeys = {};
(ppState.unlocks || []).forEach(u => { unlockedKeys[u.key] = true; });
const origLabels = {};
ppPhotoKeys(orig).forEach(k => { origLabels[k.key] = ppAnchorLabel(orig, k.idx); });
ppPhotoKeys(ppState.blocks).forEach(k => {
if (unlockedKeys[k.key]) return;
if (origLabels[k.key] !== undefined && origLabels[k.key] !== ppAnchorLabel(ppState.blocks, k.idx)) n++;
});
return n;
}
function ppUpdateIndicator() {
const el = document.getElementById('pp-staged-indicator');
if (!el) return;
const n = ppStagedCount();
el.textContent = n > 0 ? (n + ' photo change' + (n === 1 ? '' : 's') + ' staged') : '';
}
// Position of every photo: how many NON-photo blocks precede it. Non-photo
// blocks are never reordered by the panel or by the commit, so this
// coordinate survives text edits untouched; only adding/removing whole
// blocks shifts it, which the commit treats as structural divergence.
function ppPhotoPositions(blocks) {
const pos = {};
let skeleton = 0;
blocks.forEach((b, i) => {
const info = ppBlockInfo(b);
if (info.kind !== 'other') pos[ppPhotoKey(blocks, i)] = skeleton;
else skeleton++;
});
return pos;
}
function ppSkeletonCount(blocks) {
return blocks.reduce((n, b) => n + (ppBlockInfo(b).kind === 'other' ? 1 : 0), 0);
}
function ppFileOf(src) { return (src || '').split('/').pop() || 'a photo'; }
// Re-apply the staged changes to the CURRENT editor body. Returns
// { ok: true, body } or { ok: false, error } — on refusal NOTHING is written
// and the staged changes stay staged (Revert staged changes is the escape).
function ppCommitStaged(editorBody) {
if (!ppState || !ppState.dirty) return { ok: true, body: editorBody };
if (ppState.unsupported) return { ok: false, error: 'Photo changes are staged, but this post\'s body shape isn\'t panel-safe. Revert the staged photo changes in the panel, then save again.' };
const parsed = ppBlocksFromBody(editorBody);
if (parsed.stray) return { ok: false, error: 'Save stopped: the body now has loose text outside any paragraph, so the staged photo changes can\'t be applied safely. Nothing was saved — your text edits are still in the editor.' };
let blocks = parsed.blocks;
// Phase 1: staged unlocks, each behind its host-paragraph guard.
for (const u of (ppState.unlocks || [])) {
const hit = ppPhotoKeys(blocks).find(k => k.key === u.key);
if (!hit) return { ok: false, error: 'Save stopped: ' + ppFileOf(u.src) + ' is no longer in the post, so its staged unlock can\'t be applied. Nothing was saved. Revert the staged photo changes in the panel, or put the photo back, then save again.' };
const info = ppBlockInfo(blocks[hit.idx]);
if (info.kind !== 'locked' || !info.unlockable) return { ok: false, error: 'Save stopped: the paragraph holding ' + ppFileOf(u.src) + ' no longer matches the unlock you staged (it may have been edited or already split). Nothing was saved. Revert the staged photo changes in the panel, then save again.' };
const res = ppSplitLocked(blocks[hit.idx]);
if (!res || res.beforeHard !== u.beforeHard || res.afterHard !== u.afterHard) return { ok: false, error: 'Save stopped: the text around ' + ppFileOf(u.src) + ' changed in the editor after you unlocked it, so the split you previewed is no longer the split that would happen. Nothing was saved. Revert the staged photo changes in the panel, then save again.' };
blocks.splice(hit.idx, 1, ...res.parts);
}
// Phase 2: photo placements by non-photo-block position.
const stagedPos = ppPhotoPositions(ppState.blocks);
const freshKeys = ppPhotoKeys(blocks);
const stagedKeys = ppPhotoKeys(ppState.blocks);
for (const k of stagedKeys) {
if (!freshKeys.some(f => f.key === k.key)) return { ok: false, error: 'Save stopped: ' + ppFileOf(k.src) + ' was removed in the editor, but it has staged photo changes. Nothing was saved. Revert the staged photo changes in the panel, then save again.' };
}
if (ppSkeletonCount(blocks) !== ppSkeletonCount(ppState.blocks)) return { ok: false, error: 'Save stopped: paragraphs were added or removed in the editor after the photo changes were staged, so the staged positions no longer line up. Nothing was saved. Revert the staged photo changes in the panel, save your text edits, then redo the photo changes.' };
// Photos the panel doesn't know (added in the editor) keep their place.
const freshPos = ppPhotoPositions(blocks);
const targetPos = {};
freshKeys.forEach(k => { targetPos[k.key] = stagedPos[k.key] !== undefined ? stagedPos[k.key] : freshPos[k.key]; });
const photosByGap = {};
freshKeys.forEach(k => {
const g = targetPos[k.key];
if (!photosByGap[g]) photosByGap[g] = [];
photosByGap[g].push(blocks[k.idx]);
});
const skeleton = blocks.filter(b => ppBlockInfo(b).kind === 'other');
const out = [];
let si = 0;
const emitGap = g => { (photosByGap[g] || []).forEach(p => out.push(p)); };
emitGap(0);
skeleton.forEach(b => { out.push(b); si++; emitGap(si); });
const candidate = ppNormalize(out).join('');
const violations = ppCheckInvariants(editorBody, candidate);
if (violations.length) return { ok: false, error: 'Save stopped by the panel\'s safety check: ' + violations.join(' and ') + '. Nothing was saved.' };
return { ok: true, body: candidate };
}
// Called by savePost after ANY successful editor save (200, or 409
// INDEX_CONFLICT where the blob landed): the saved body is the new truth.
function ppAfterCommittedSave(savedBody) {
if (quill) quill.root.innerHTML = savedBody;
if (!ppState) { initPhotoPanel(); return; }
const wasDirty = ppState.dirty;
const parsed = ppBlocksFromBody(savedBody);
ppState = { originalBody: savedBody, blocks: parsed.blocks, dirty: false, unsupported: parsed.stray, unlocks: [] };
ppRender();
ppUpdateIndicator();
if (wasDirty) ppNotice('ok', 'Photo changes saved with the post.');
}
// === PHOTO PANEL END ===

function onHeroUrlChange() {
const url = document.getElementById('f-hero-url').value.trim();
document.getElementById('hero-preview').src = url;
document.getElementById('og-img').src = url;
updatePreviews();
}

function onTitleChange() {
const title = document.getElementById('f-title').value;
const slugEl = document.getElementById('f-slug');
if (!currentPost || !slugEl.value) slugEl.value = slugify(title);
updatePreviews();
}

function slugify(str) {
return str.toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}

function onMetaChange() {
const len = document.getElementById('f-meta').value.length;
const el = document.getElementById('meta-counter');
el.textContent = len + ' / 160';
el.className = 'meta-counter' + (len >= 160 ? ' danger' : len >= 140 ? ' warn' : '');
updatePreviews();
}

function updatePreviews() {
const title = document.getElementById('f-title').value || 'Post title';
const slug = document.getElementById('f-slug').value || '';
const meta = document.getElementById('f-meta').value || 'Meta description will appear here...';
const heroSrc = document.getElementById('f-hero-url')?.value || document.getElementById('hero-preview').src;
document.getElementById('slug-preview').textContent = 'themeparkcopilot.com/blog/' + slug;
document.getElementById('seo-title').textContent = title.slice(0,60);
document.getElementById('seo-url').textContent = 'themeparkcopilot.com/blog/' + slug;
document.getElementById('seo-desc').textContent = meta.slice(0,160);
document.getElementById('og-title').textContent = title.slice(0,70);
document.getElementById('og-desc').textContent = meta.slice(0,120);
if (heroSrc) document.getElementById('og-img').src = heroSrc;
}

// ============================================================
// FAQ
// ============================================================
function addFaqItem(q, a) {
const list = document.getElementById('faq-list');
const div = document.createElement('div');
div.className = 'faq-item-editor';
div.innerHTML = '<button class="faq-remove" onclick="this.parentElement.remove();markDirty()">&times;</button>' +
'<div class="field-label" style="margin-bottom:6px">Question</div>' +
'<input type="text" class="field-input" placeholder="Question" value="' + escHtml(q||'') + '" oninput="markDirty()" style="margin-bottom:8px">' +
'<div class="field-label" style="margin-bottom:6px">Answer</div>' +
'<textarea class="field-textarea" placeholder="Answer" rows="3" oninput="markDirty()">' + escHtml(a||'') + '</textarea>';
list.appendChild(div);
}

// ============================================================
// RELATED
// ============================================================
function addRelatedRow(selectedSlug) {
const list = document.getElementById('related-list');
const div = document.createElement('div');
div.className = 'related-row';
const opts = allPosts.map(p => '<option value="' + p.slug + '" ' + (p.slug===selectedSlug?'selected':'') + '>' + escHtml(p.title||p.slug) + '</option>').join('');
div.innerHTML = '<select onchange="markDirty()">' + opts + '</select><button class="related-remove" onclick="this.parentElement.remove();markDirty()">&times;</button>';
list.appendChild(div);
}

// ============================================================
// FOCAL POINT
// ============================================================
function setFocal(val) {
document.querySelectorAll('.focal-dot').forEach(d => { d.classList.toggle('selected', d.dataset.focal === val); });
document.getElementById('hero-preview').style.objectPosition = val;
document.getElementById('hero-preview').dataset.focal = val;
}
// ============================================================
// SAVE / PUBLISH
// ============================================================
function collectPost(publish) {
const faqs = [];
document.querySelectorAll('#faq-list .faq-item-editor').forEach(item => {
const inputs = item.querySelectorAll('input,textarea');
if (inputs[0] && inputs[1]) faqs.push({ q: inputs[0].value.trim(), a: inputs[1].value.trim() });
});
const related = [];
document.querySelectorAll('#related-list .related-row select').forEach(sel => {
const slug = sel.value;
const post = allPosts.find(p => p.slug === slug);
if (post) related.push({ slug: post.slug, park: post.park, title: post.title, heroImage: post.heroImage || '' });
});
const slug = document.getElementById('f-slug').value.trim();
const park = document.getElementById('f-park').value;
const ctaType = document.getElementById('f-cta-type').value;
const now = new Date().toISOString();
const existingPublishedAt = currentPost ? currentPost.publishedAt : null;
const isPublished = publish ? true : document.getElementById('f-published').checked;
const bodyHtml = quill ? quill.root.innerHTML : '';
let readTime = document.getElementById('f-readtime').value || '5';
if (appSettings.readTimeMode === 'auto' || !readTime || readTime === '') {
readTime = String(calcReadTime(bodyHtml));
}
const CTA_TEXT = {
dl: { text: 'Get the Theme Park Co-Pilot app and see real Disneyland wait times, crowd forecasts, and personalized plans.', buttonText: 'Try free for 7 days &#8594;', buttonUrl: 'https://themeparkcopilot.com' },
wdw: { text: 'Get the Theme Park Co-Pilot app and see real Walt Disney World wait times, crowd forecasts, and personalized plans.', buttonText: 'Try free for 7 days &#8594;', buttonUrl: 'https://themeparkcopilot.com' },
both: { text: 'Get the Theme Park Co-Pilot app and see real Disney park wait times, crowd forecasts, and personalized plans for every resort.', buttonText: 'Try free for 7 days &#8594;', buttonUrl: 'https://themeparkcopilot.com' }
};
const parkLabels = { dl: 'Disneyland', wdw: 'Walt Disney World', both: 'Both Resorts' };
const category = parkLabels[park] + ' &middot; Guide';
const heroImage = document.getElementById('f-hero-url')?.value?.trim() || document.getElementById('hero-preview').src || '';
// Preserve scheduledAt if not publishing
const scheduledAt = (!publish && currentPost && currentPost.scheduledAt) ? currentPost.scheduledAt : null;
return {
slug, title: document.getElementById('f-title').value.trim(),
metaDescription: document.getElementById('f-meta').value.trim(),
park, category, tagLabel: parkLabels[park],
heroImage, heroAlt: document.getElementById('f-hero-alt').value.trim(),
heroFocal: document.getElementById('hero-preview').dataset.focal || 'center',
intro: document.getElementById('f-intro').value.trim(),
readTime, publishedAt: currentPost ? currentPost.publishedAt : null, updatedAt: new Date().toISOString(),
published: isPublished, scheduledAt, body: bodyHtml, faqs, related,
cta: { type: ctaType, ...CTA_TEXT[ctaType] },
tags: (document.getElementById('f-tags').value || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean)
};
}

async function savePost(post) {
// PR #62: staged photo-panel changes commit HERE — the one commit point.
// The panel re-applies its staged moves/unlocks to the body being saved; a
// refusal aborts the save before anything is written, naming the photo.
if (typeof ppCommitStaged === 'function') {
const staged = ppCommitStaged(post.body);
if (!staged.ok) {
showToast(staged.error, 'error');
if (typeof ppNotice === 'function') ppNotice('error', staged.error);
return;
}
post.body = staged.body;
}
const btn = document.getElementById('btn-publish');
const origText = btn ? btn.textContent : '';
if (btn) { btn.textContent = 'Saving...'; btn.classList.add('btn-loading'); btn.disabled = true; }

if (!post.slug) { showToast('Slug is required', 'error'); btn.textContent = origText; btn.classList.remove('btn-loading'); btn.disabled = false; return; }
try {
const r = await fetch(API_BASE + '/api/blog-save', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify(post)
});
const data = await r.json();
// A 409 INDEX_CONFLICT means the post blob WAS written and only the index
// lagged (PR #52 semantics) — the save landed; treat it as success.
if ((r.ok && data.success) || (r.status === 409 && data && data.code === 'INDEX_CONFLICT')) {
if (data.slug) optimisticUpsert(data.slug, toOptimisticEntry(post, allPosts.find(function(p) { return p.slug === post.slug; })));
currentPost = post;
isDirty = false;
if (typeof ppAfterCommittedSave === 'function') ppAfterCommittedSave(post.body);
document.getElementById('f-readtime').value = post.readTime;
document.getElementById('f-published').checked = post.published;
document.getElementById('status-label').textContent = post.published ? 'Published' : 'Draft';
document.getElementById('btn-delete-post').style.display = 'block';
// Hide schedule button after publishing
if (post.published) document.getElementById('btn-schedule').style.display = 'none';
showToast(post.published ? 'Published &#10003;' : 'Saved &#10003;', 'success');
await loadPosts();
      if (post.published && document.getElementById('images-view') && document.getElementById('images-view').style.display !== 'none') { loadImagesInline(); }
} else { showToast(data.error || 'Save failed &mdash; try again', 'error'); }
} catch(e) { showToast('Save failed &mdash; try again', 'error'); }
finally { if (btn) { btn.textContent = origText; btn.classList.remove('btn-loading'); btn.disabled = false; } }
}

async function goLive() {
  const post = collectPost();
  post.published = true;
  post.publishedAt = new Date().toISOString();
  post.updatedAt = new Date().toISOString();
  post.scheduledAt = null;
  try {
    await savePost(post);
  } catch (e) {
    console.warn('savePost error in goLive (non-fatal):', e);
  }
  try {
    await fetch(API_BASE + '/api/blog-reindex', {
      method: 'GET',
      headers: { 'x-reindex-secret': 'tpcp-reindex-2026' }
    });
  } catch (e) {
    console.warn('Reindex after publish failed (non-fatal):', e);
  }
  showView('posts');
}
// ============================================================
function updatePost() { const post = collectPost(); post.published = true; post.publishedAt = currentPost && currentPost.publishedAt ? currentPost.publishedAt : post.publishedAt; post.updatedAt = new Date().toISOString(); savePost(post); }
function saveDraft() { const post = collectPost(); post.published = false; savePost(post); }
function previewPost() { const slug = document.getElementById('f-slug').value.trim(); if (slug) window.open('/blog/' + slug, '_blank'); }
function quickDelete(slug, fromView) { currentPost = { slug }; _deleteFromView = fromView || null; confirmDelete(); }
function confirmDelete() { document.getElementById('delete-modal').classList.add('active'); }
async function executeDelete() {
const slug = currentPost ? currentPost.slug : null;
if (!slug) { closeModal('delete-modal'); return; }
const btn = document.getElementById('confirm-delete-btn');
btn.textContent = 'Deleting...'; btn.disabled = true;
try {
const r = await fetch(API_BASE + '/api/blog-delete', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify({ slug })
});
const data = await r.json();
if (r.ok && data.success) {
optimisticRemove(slug);
closeModal('delete-modal');
showToast('Post deleted', 'success');
currentPost = null; isDirty = false;
await loadPosts();
if (_deleteFromView === 'drafts') { showView('drafts'); }
else { showView('posts'); }
_deleteFromView = null;
} else { showToast('Delete failed', 'error'); }
} catch(e) { showToast('Delete failed', 'error'); }
finally { btn.textContent = 'Delete'; btn.disabled = false; }
}

function closeModal(id) { document.getElementById(id).classList.remove('active'); }
// ============================================================
// FIX 4: SCHEDULING
// ============================================================
function openScheduleModal() {
const modal = document.getElementById('schedule-modal');
const dt = document.getElementById('schedule-datetime');
const cancelBtn = document.getElementById('btn-cancel-schedule');
const title = document.getElementById('schedule-modal-title');
if (currentPost && currentPost.scheduledAt) {
// Pre-fill with existing scheduled time
const localDatetime = new Date(currentPost.scheduledAt);
const offset = localDatetime.getTimezoneOffset() * 60000;
const localISO = new Date(localDatetime.getTime() - offset).toISOString().slice(0, 16);
document.getElementById('schedule-datetime').value = localISO;
cancelBtn.style.display = 'inline-block';
title.textContent = 'Reschedule Post';
} else {
// Default to tomorrow at 9am
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(9, 0, 0, 0);
const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0,16);
dt.value = local;
cancelBtn.style.display = 'none';
title.textContent = 'Schedule Post';
}
modal.classList.add('active');
}

function confirmSchedule() {
  const input = document.getElementById('schedule-datetime').value;
  if (!input) { showToast('Pick a date and time', 'error'); return; }
  const localDate = new Date(input);
  if (localDate <= new Date()) { showToast('Scheduled time must be in the future', 'error'); return; }
  const utcString = localDate.toISOString();
  saveDraftWithSchedule(utcString);
}

async function saveDraftWithSchedule(utcString) {
  const slug = document.getElementById('f-slug').value.trim() || (currentPost && currentPost.slug);
  if (!slug) { showToast('Save the post first', 'error'); return; }
  // Save draft first to persist any unsaved changes
  if (isDirty) {
    await saveDraft();
  }
  try {
    const r = await fetch(API_BASE + '/api/blog-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
      body: JSON.stringify({ slug, scheduledAt: utcString })
    });
    const data = await r.json();
    if (r.ok && data.success) {
      if (currentPost) currentPost.scheduledAt = utcString;
      closeModal('schedule-modal');
      const btn = document.getElementById('btn-schedule');
      btn.textContent = 'Scheduled - ' + formatScheduledDate(utcString);
      showToast('Scheduled for ' + formatScheduledDate(utcString), 'success');
      await loadPosts();
    } else { showToast('Schedule failed', 'error'); }
  } catch(e) { showToast('Schedule failed', 'error'); }
}

async function cancelSchedule() {
const slug = document.getElementById('f-slug').value.trim() || (currentPost && currentPost.slug);
if (!slug) { closeModal('schedule-modal'); return; }
try {
const r = await fetch(API_BASE + '/api/blog-schedule', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify({ slug, scheduledAt: null })
});
const data = await r.json();
if (r.ok && data.success) {
if (currentPost) currentPost.scheduledAt = null;
closeModal('schedule-modal');
document.getElementById('btn-schedule').textContent = 'Schedule';
showToast('Schedule removed', 'success');
await loadPosts();
} else { showToast('Failed to cancel schedule', 'error'); }
} catch(e) { showToast('Failed to cancel schedule', 'error'); }
}
// ============================================================
// FIX 2: IMAGE MANAGER WITH UPLOAD QUEUE
// ============================================================
function openImageManager(ctx) {
imgManagerContext = ctx;
uploadQueue = [];
uploadDone = false;
const modal = document.getElementById('img-modal');
const titleEl = modal.querySelector('.img-modal-title');
const dropZone = document.getElementById('img-drop-zone');
const uploadQueueEl = document.getElementById('upload-queue');
const addPhotosBtn = modal.querySelector('.btn-upload-img');
const pickerCancelBtn = document.getElementById('img-picker-cancel');
if (ctx === 'hero' || ctx === 'quill') {
if (titleEl) titleEl.textContent = 'Choose from Library';
if (dropZone) dropZone.style.display = 'none';
if (uploadQueueEl) uploadQueueEl.style.display = 'none';
if (addPhotosBtn) addPhotosBtn.style.display = 'none';
if (pickerCancelBtn) pickerCancelBtn.style.display = 'inline-block'; modal.style.background = '';
} else {
if (titleEl) titleEl.textContent = 'Image Library';
if (dropZone) dropZone.style.display = '';
if (addPhotosBtn) addPhotosBtn.style.display = '';
if (pickerCancelBtn) pickerCancelBtn.style.display = 'none';
renderUploadQueue();
const imgGrid = document.getElementById('img-grid'); if (imgGrid) imgGrid.innerHTML = ''; modal.style.background = 'rgba(7,30,37,1)'; setupDragDrop();
}
modal.classList.add('active');
if (ctx === 'hero' || ctx === 'quill') { loadImages(); }
}
function closeImageManager() {
// If there are queued files not yet uploaded, confirm
if (uploadQueue.length > 0 && !uploadDone) {
document.getElementById('unsaved-uploads-modal').classList.add('active');
return;
}
forceCloseImageManager();
}

function forceCloseImageManager() {
closeModal('unsaved-uploads-modal');
uploadQueue = [];
uploadDone = false;
document.getElementById('img-modal').classList.remove('active');
if (uploadDone) loadImages();
}

function openHeroUpload() {
const fileInput = document.getElementById('hero-upload-input');
if (!fileInput) return;
fileInput.onchange = async function() {
const file = this.files[0];
if (!file) return;
this.value = '';
const progress = document.getElementById('hero-upload-progress');
if (progress) { progress.textContent = 'Uploading...'; progress.style.display = 'block'; }
try {
const r = await fetch(API_BASE + '/api/blog-upload-image', {
method: 'POST',
headers: { 'x-admin-key': token, 'x-filename': file.name, 'Content-Type': file.type },
body: file
});
const data = await r.json();
if (r.ok && data.url) {
document.getElementById('hero-preview').src = data.url;
document.getElementById('f-hero-url').value = data.url;
document.getElementById('og-img').src = data.url;
markDirty();
if (progress) { progress.textContent = 'Uploaded!'; setTimeout(() => { progress.style.display = 'none'; }, 1500); }
showToast('Hero image uploaded', 'success');
} else {
if (progress) { progress.textContent = 'Upload failed'; setTimeout(() => { progress.style.display = 'none'; }, 2000); }
showToast('Upload failed', 'error');
}
} catch(e) {
if (progress) { progress.textContent = 'Upload error'; setTimeout(() => { progress.style.display = 'none'; }, 2000); }
showToast('Upload error', 'error');
}
};
fileInput.click();
}

function setupDragDrop() {
const zone = document.getElementById('img-drop-zone');
if (!zone || zone._ddSetup) return;
zone._ddSetup = true;
zone.addEventListener('click', () => document.getElementById('file-input').click());
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
zone.addEventListener('drop', e => {
e.preventDefault();
zone.classList.remove('dragover');
const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
files.forEach(f => addToQueue(f));
});
}

function handleFileSelect(input) {
const files = Array.from(input.files).filter(f => f.type.startsWith('image/'));
files.forEach(f => addToQueue(f));
input.value = '';
}

function triggerUpload() {
document.getElementById('file-input').click();
}

function addToQueue(file) {
uploadDone = false;
const reader = new FileReader();
reader.onload = e => {
uploadQueue.push({ file, dataUrl: e.target.result });
renderUploadQueue();
};
reader.readAsDataURL(file);
}

function removeFromQueue(idx) {
uploadQueue.splice(idx, 1);
renderUploadQueue();
}

function renderUploadQueue() {
const queueEl = document.getElementById('upload-queue');
const countEl = document.getElementById('queue-count');
const btnUpload = document.getElementById('btn-upload-queue');
const gridEl = document.getElementById('upload-queue-grid');
if (uploadQueue.length === 0 && !uploadDone) {
queueEl.style.display = 'none';
return;
}
queueEl.style.display = 'block';
if (countEl) countEl.textContent = uploadQueue.length;
if (gridEl) {
gridEl.innerHTML = uploadQueue.map((item, idx) =>
'<div class="queue-thumb">' +
'<img src="' + item.dataUrl + '" alt="">' +
'<div class="queue-thumb-name">' + escHtml(item.file.name) + '</div>' +
'<button class="queue-thumb-remove" onclick="removeFromQueue(' + idx + ')">&times;</button>' +
'</div>'
).join('');
gridEl.innerHTML += uploadQueue.map((item, idx) => queueMetaRow(item, idx)).join('');
}
if (uploadDone) {
if (btnUpload) {
btnUpload.outerHTML = '<button class="btn-done-upload" onclick="doneUpload()">Done</button>';
}
} else {
if (btnUpload) {
btnUpload.textContent = 'Upload ' + uploadQueue.length + ' photo(s)';
btnUpload.disabled = uploadQueue.length === 0;
}
}
}

function doneUpload() {
// Reset JS state
uploadQueue = [];
uploadDone = false;
// Reset progress element
var prog = document.getElementById('upload-progress');
if (prog) { prog.textContent = ''; prog.style.display = 'none'; }
// Restore upload-queue DOM to original structure
var queueEl = document.getElementById('upload-queue');
if (queueEl) {
queueEl.style.display = 'none';
queueEl.innerHTML =
'<div class="field-label" style="margin-bottom:8px">Queue (<span id="queue-count">0</span> photo(s))</div>' +
'<div class="upload-queue-grid" id="upload-queue-grid"></div>' +
'<div class="upload-progress" id="upload-progress" style="display:none"></div>' +
'<button class="btn-upload-queue" id="btn-upload-queue" disabled onclick="startUploadQueue()">Upload 0 photo(s)</button>';
}
// Close modal directly
document.getElementById('img-modal').classList.remove('active');
// Reload inline grid with delay for CDN availability
if (document.getElementById('images-view') && document.getElementById('images-view').style.display !== 'none') {
setTimeout(function() { loadImagesInline(); }, 2000);
}
}
async function uploadQueue_fn() {
const total = uploadQueue.length;
if (total === 0) return;
const progress = document.getElementById('upload-progress');
const btn = document.getElementById('btn-upload-queue');
if (btn) btn.disabled = true;
progress.style.display = 'block';
progress.style.color = '#0A4840';
const warning = document.getElementById('upload-warning');
let successCount = 0;
for (let i = 0; i < uploadQueue.length; i++) {
const item = uploadQueue[i];
progress.textContent = 'Uploading ' + (i + 1) + ' of ' + total + '...';
// Check large PNG
if (item.file.type === 'image/png' && item.file.size > 1024 * 1024) {
if (warning) { warning.textContent = 'Large PNG detected â consider JPG for faster load'; warning.style.display = 'block'; }
}
try {
const r = await fetch(API_BASE + '/api/blog-upload-image', {
method: 'POST',
headers: { 'x-admin-key': token, 'x-filename': item.file.name, 'Content-Type': item.file.type },
body: item.file
});
const data = await r.json();
// Fix 1: check data.url (matches what blog-upload-image.js returns)
if (r.ok && data.url) { successCount++; if (item.meta && (item.meta.alt || item.meta.credit)) { await saveImageMeta(data.url, { alt: item.meta.alt || '', credit: item.meta.credit || '', creditUrl: '', source: item.meta.source || 'own', creditRequired: item.meta.source === 'commons' }); } }
else { progress.textContent = 'Failed: ' + item.file.name; progress.style.color = '#C82030'; await sleep(1000); progress.style.color = '#0A4840'; }
} catch(e) { progress.textContent = 'Upload error: ' + item.file.name; progress.style.color = '#C82030'; await sleep(1000); progress.style.color = '#0A4840'; }
}
progress.textContent = successCount + ' of ' + total + ' uploaded';
uploadQueue = [];
uploadDone = true;
renderUploadQueue();
// Fix 1: Refresh the Image Library grid after upload so new images appear immediately
setTimeout(function() { loadImagesInline(); }, 1500);
}

// Alias
async function startUploadQueue() { await uploadQueue_fn(); }

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function loadImages() {
loadImageMeta();
const grid = document.getElementById('img-grid');
const empty = document.getElementById('img-empty');
if (!grid) return;
grid.innerHTML = '<div style="color:#8AACAE;font-size:13px;padding:20px">Loading...</div>';
if (empty) empty.style.display = 'none';
try {
const r = await fetch(API_BASE + '/api/blog-images', { headers: { 'x-admin-key': token } });
const images = await r.json();
if (!images.length) { grid.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
grid.innerHTML = images.map(img =>
'<div class="img-cell" style="position:relative">' +
'<div class="img-cell-wrap" onclick="selectImage(' + "'" + escAttr(img.url) + "'" + ')">' +
'<img src="' + escAttr(img.url) + '" alt="' + escAttr(img.filename) + '" loading="lazy">' +
(imgManagerContext !== 'hero' ? '<div class="img-cell-actions">' +
'<button class="img-cell-btn" onclick="event.stopPropagation();copyImgUrl(' + "'" + escAttr(img.url) + "',this" + ')">Copy URL</button>' +
'<button class="img-cell-btn" onclick="event.stopPropagation();openMetaEditor(' + "'" + escAttr(img.url) + "'" + ')">Meta</button>' +
'<button class="img-cell-btn danger" onclick="event.stopPropagation();deleteImage(' + "'" + escAttr(img.url) + "'" + ')">Delete</button>' +
'</div>' : '') +
'</div>' +
'<div class="img-cell-name">' + escHtml(img.filename) + '</div>' +
'<span class="meta-chip" data-meta-url="' + escAttr(img.url) + '"></span>' +
(imgManagerContext !== 'hero' ? '<button class="img-set-hero-btn" onclick="setHeroFromLibrary(' + "'" + escAttr(img.url) + "'" + ')">Set as hero</button>' : '') +
'</div>'
).join('');
} catch(e) {
grid.innerHTML = '<div style="color:#C82030;font-size:13px;padding:20px">Failed to load images.</div>';
}
}

function copyImgUrl(url, btn) {
navigator.clipboard.writeText(url).then(() => {
const orig = btn.textContent;
btn.textContent = 'Copied!';
setTimeout(() => { btn.textContent = orig; }, 1500);
}).catch(() => { showToast('Copy failed', 'error'); });
}


function deleteImage(url) {
  if (imgSelectMode) return;
  var img = (window._currentImages || []).find(function(i) { return i.url === url; });
  if (img && img.usedBy && img.usedBy.length > 0) {
    showImageDeleteWarning(url, img.usedBy);
    return;
  }
  confirmDeleteImage(url);
}

function showImageDeleteWarning(url, usedBy) {
  var modal = document.getElementById('img-in-use-modal');
  var bodyEl = document.getElementById('img-in-use-body');
  var postList = (usedBy || []).map(function(e) {
    return '"' + (e.title || e.slug) + '" (' + (e.published ? 'published' : 'draft') + ')';
  }).join(', ');
  if (bodyEl) bodyEl.textContent = 'This image is used by: ' + postList + '. Remove it from the post before deleting.';
  document.getElementById('img-in-use-multi-actions').style.display = 'none';
  document.getElementById('img-in-use-single-actions').style.display = 'flex';
  var deleteAnywayBtn = document.getElementById('img-in-use-delete-anyway');
  var moveToUsedBtn = document.getElementById('img-in-use-move');
  var cancelBtn = document.getElementById('img-in-use-cancel');
  if (deleteAnywayBtn) deleteAnywayBtn.style.display = 'none';
  if (moveToUsedBtn) moveToUsedBtn.onclick = function() { closeModal('img-in-use-modal'); };
  if (cancelBtn) cancelBtn.onclick = function() { closeModal('img-in-use-modal'); };
  modal.classList.add('active');
}

async function confirmDeleteImage(url) {
  try {
    var r = await fetch(API_BASE + '/api/blog-images', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
      body: JSON.stringify({ url: url })
    });
    if (r.ok) {
      loadImagesInline();
    } else if (r.status === 409) {
      var data = await r.json();
      showToast(data.error || 'Image is in use', 'error');
      loadImagesInline();
    } else {
      showToast('Delete failed', 'error');
    }
  } catch (e) { showToast('Delete failed', 'error'); }
}

function setHeroFromLibrary(url) {
document.getElementById('hero-preview').src = url;
document.getElementById('f-hero-url').value = url;
document.getElementById('og-img').src = url;
markDirty();
forceCloseImageManager();
showToast('Hero image set', 'success');
}

// ============================================================
// MULTI-SELECT DELETE (Image Library)
// ============================================================
function enterSelectMode() {
imgSelectMode = true;
selectedImgUrls = new Set();
// Toggle button visibility
const btnSel = document.getElementById('btn-img-select');
const btnUp = document.getElementById('btn-img-upload');
if (btnSel) { btnSel.textContent = 'Cancel'; btnSel.onclick = exitSelectMode; }
if (btnUp) btnUp.style.display = 'none';
// Add select-mode class to grid wrapper so checkboxes show
const grid = document.getElementById('lib-img-grid');
if (grid) grid.classList.add('img-select-mode');
// Show the bar
const bar = document.getElementById('multi-select-bar');
if (bar) bar.style.display = 'flex';
updateSelectBar();
}

function exitSelectMode() {
imgSelectMode = false;
selectedImgUrls = new Set();
// Restore button
const btnSel = document.getElementById('btn-img-select');
const btnUp = document.getElementById('btn-img-upload');
if (btnSel) { btnSel.textContent = 'Select'; btnSel.onclick = enterSelectMode; }
if (btnUp) btnUp.style.display = '';
// Remove select-mode class and deselect all
const grid = document.getElementById('lib-img-grid');
if (grid) {
grid.classList.remove('img-select-mode');
grid.querySelectorAll('.img-cell.selected').forEach(el => el.classList.remove('selected'));
}
// Hide bar
const bar = document.getElementById('multi-select-bar');
if (bar) bar.style.display = 'none';
}

function imgCellClick(event, cellEl, url) {
if (!imgSelectMode) {
return;
}
event.stopPropagation();
if (selectedImgUrls.has(url)) {
selectedImgUrls.delete(url);
cellEl.classList.remove('selected');
} else {
selectedImgUrls.add(url);
cellEl.classList.add('selected');
}
updateSelectBar();
}

function updateSelectBar() {
const n = selectedImgUrls.size;
const label = document.getElementById('select-count-label');
const btn = document.getElementById('btn-delete-selected');
if (label) label.textContent = n + ' selected';
if (btn) {
btn.textContent = 'Delete Selected (' + n + ')';
btn.disabled = n === 0;
}
}

function confirmMultiDelete() {
const n = selectedImgUrls.size;
if (!n) return;
executeMultiDelete();
}

async function executeMultiDelete() {
  var urls = Array.from(selectedImgUrls);
  var currentImages = window._currentImages || [];
  var inUseUrls = urls.filter(function(u) {
    var img = currentImages.find(function(i) { return i.url === u; });
    return img && img.usedBy && img.usedBy.length > 0;
  });
  var safeUrls = urls.filter(function(u) {
    var img = currentImages.find(function(i) { return i.url === u; });
    return !img || !img.usedBy || img.usedBy.length === 0;
  });
  if (inUseUrls.length > 0) {
    confirmMultiDeleteInUse(inUseUrls, safeUrls);
    return;
  }
  await _doMultiDelete(urls);
}

async function _doMultiDelete(urls) {
  var btn = document.getElementById('btn-delete-selected');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }
  var failed = 0;
  var blocked = 0;
  for (var i = 0; i < urls.length; i++) {
    try {
      var r = await fetch(API_BASE + '/api/blog-images', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
        body: JSON.stringify({ url: urls[i] })
      });
      if (r.status === 409) { blocked++; }
      else if (!r.ok) { failed++; }
    } catch (e) { failed++; }
  }
  if (blocked) showToast(blocked + ' image(s) still in use and were not deleted', 'error');
  else if (failed) showToast(failed + ' deletion(s) failed', 'error');
  else showToast('Deleted ' + urls.length + ' image' + (urls.length !== 1 ? 's' : ''), 'success');
  exitSelectMode();
  await loadImagesInline();
}


function confirmMultiDeleteInUse(inUseUrls, safeUrls) {
  _deleteInUseMultiUrls = inUseUrls;
  _deleteInUseSafeUrls = safeUrls;
  var currentImages = window._currentImages || [];
  var postTitles = [];
  inUseUrls.forEach(function(url) {
    var img = currentImages.find(function(i) { return i.url === url; });
    if (img && img.usedBy) {
      img.usedBy.forEach(function(e) {
        var label = (e.title || e.slug) + (e.published ? '' : ' (draft)');
        if (postTitles.indexOf(label) < 0) postTitles.push(label);
      });
    }
  });
  var bodyEl = document.getElementById('img-in-use-body');
  if (bodyEl) bodyEl.textContent = inUseUrls.length + ' of your selected images are used in: ' +
    postTitles.map(function(t) { return escHtml(t); }).join(', ') +
    '. Only the unused images will be deleted.';
  document.getElementById('img-in-use-multi-actions').style.display = 'flex';
  document.getElementById('img-in-use-single-actions').style.display = 'none';
  document.getElementById('img-in-use-modal').classList.add('active');
}


function moveMultiToUsedPhotos() {
  var safeUrls = _deleteInUseSafeUrls || [];
  _deleteInUseMultiUrls = null;
  _deleteInUseSafeUrls = null;
  closeModal('img-in-use-modal');
  exitSelectMode();
  if (safeUrls.length > 0) {
    _doMultiDelete(safeUrls).then(function() {
      showToast('In-use images kept. Unused images deleted.', 'success');
    });
  } else {
    showToast('No unused images selected to delete.', 'success');
    loadImagesInline();
  }
}

async function loadImagesInline() {
loadImageMeta();
  if (isLoadingImages) return;
  isLoadingImages = true;
  try {
    var q = "'";
    var grid = document.getElementById('images-inline-grid');
    var usedSection = document.getElementById('used-photos-section');
    var usedGrid = document.getElementById('used-photos-grid');
    grid.innerHTML = '<div style="color:#8AACAE;font-size:13px">Loading...</div>';
    if (usedSection) usedSection.style.display = 'none';
    var images = [];
    try {
      var libRes = await fetch(API_BASE + '/api/blog-images', { headers: { 'x-admin-key': token } });
      images = libRes.ok ? await libRes.json() : [];
      if (!images || images.length === 0) { grid.innerHTML = '<div class="coming-soon">No images yet. Use Upload Image above.</div>'; updateSelectBar(); return; }
    } catch (e) {
      grid.innerHTML = '<div style="color:#C82030;font-size:13px">Failed to load images.</div>';
      return;
    }
    window._currentImages = images;
    var unusedImages = images.filter(function(img) { return img.usedBy.length === 0; });
    var usedImages = images.filter(function(img) { return img.usedBy.length > 0; });
    if (unusedImages.length === 0) {
      grid.innerHTML = '<div class="coming-soon">All uploaded images are currently in use.</div>';
    } else {
      grid.innerHTML = '<div class="img-grid" id="lib-img-grid">' + unusedImages.map(function(img) {
        var isSel = selectedImgUrls.has(img.url);
        return '<div class="img-cell' + (isSel ? ' selected' : '') + '" style="position:relative" data-url="' + escAttr(img.url) + '" onclick="imgCellClick(event,this,' + q + escAttr(img.url) + q + ')">' +
          '<div class="img-cell-check"></div>' +
          '<div class="img-cell-wrap">' +
          '<img src="' + escAttr(img.url) + '" alt="' + escAttr(img.filename) + '" loading="lazy">' +
          '<div class="img-cell-actions">' +
          '<button class="img-cell-btn" onclick="event.stopPropagation();copyImgUrl(' + q + escAttr(img.url) + q + ',this)">Copy URL</button>' +
'<button class="img-cell-btn" onclick="event.stopPropagation();openMetaEditor(' + q + escAttr(img.url) + q + ')">Meta</button>' +
          '<button class="img-cell-btn danger" onclick="event.stopPropagation();deleteImage(' + q + escAttr(img.url) + q + ')">Delete</button>' +
          '</div>' +
          '</div>' +
          '<div class="img-cell-name">' + escHtml(img.filename) + '</div>' +
'<span class="meta-chip" data-meta-url="' + escAttr(img.url) + '"></span>' +
          '</div>';
      }).join('') + '</div>';
    }
    updateSelectBar();
    if (usedImages.length > 0 && usedSection && usedGrid) {
      usedSection.style.display = 'block';
      usedGrid.innerHTML = usedImages.map(function(img) {
        var postLabel = img.usedBy.map(function(e) {
          return escHtml((e.title || e.slug) + (e.published ? '' : ' (draft)'));
        }).join(', ');
        return '<div class="used-photo-cell" style="position:relative">' +
          '<div class="img-cell-wrap">' +
          '<img src="' + escAttr(img.url) + '" alt="' + escAttr(img.filename) + '" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">' +
          '<div class="img-cell-actions">' +
          '<button class="img-cell-btn" onclick="event.stopPropagation();copyImgUrl(' + q + escAttr(img.url) + q + ',this)">Copy URL</button>' +
'<button class="img-cell-btn" onclick="event.stopPropagation();openMetaEditor(' + q + escAttr(img.url) + q + ')">Meta</button>' +
          '</div>' +
          '</div>' +
          '<button type="button" class="btn-use-image" onclick="selectImage(\'' + escAttr(img.url) + '\')" ' +
          'style="margin-top:6px;padding:4px 10px;background:#1A6860;color:#fff;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Use</button>' +
          '<div class="used-photo-title" title="' + escAttr(postLabel) + '">' + postLabel + '</div>' +
          '</div>';
      }).join('');
    } else if (usedSection) {
      usedSection.style.display = 'none';
    }
  } finally {
    isLoadingImages = false;
  }
}


// === IMAGE META SECTION START ===
// Per-image metadata registry (alt + credit) -- editor side. Records live
// in the blog/image-meta blob via api/blog-image-meta.js and are keyed by
// image pathname. Alt attaches automatically at insert; a photo whose
// record says a credit is legally required (creditRequired, e.g. a
// Wikimedia Commons CC BY / BY-SA image) cannot be inserted until its
// credit exists -- a published post missing that credit is out of license
// compliance for every day it is live. Everything here fails soft: if the
// registry cannot be read, inserts behave exactly as they did before.
let imageMeta = {};
let imageMetaLoaded = false;
let metaModalState = null;
function metaKey(url) {
try { return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, ''); } catch (e) { return ''; }
}
function metaRec(url) { return imageMeta[metaKey(url)] || null; }
async function loadImageMeta() {
try {
const r = await fetch(API_BASE + '/api/blog-image-meta', { headers: { 'x-admin-key': token } });
if (!r.ok) return;
const data = await r.json();
imageMeta = (data && data.records) || {};
imageMetaLoaded = true;
refreshMetaChips();
} catch (e) { /* fail soft */ }
}
async function saveImageMeta(url, rec) {
const path = metaKey(url);
if (!path) return false;
try {
const r = await fetch(API_BASE + '/api/blog-image-meta', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify({ pathname: path, record: rec })
});
if (!r.ok) return false;
imageMeta[path] = {
alt: rec.alt || '', credit: rec.credit || '', creditUrl: rec.creditUrl || '',
source: rec.source || 'unknown', creditRequired: rec.creditRequired === true
};
refreshMetaChips();
return true;
} catch (e) { return false; }
}
function insertGate(rec) {
if (rec && rec.creditRequired && !rec.credit) return 'block';
if (!rec || !rec.alt) return 'prompt';
return 'ok';
}
function metaChipState(rec) {
if (!rec) return { cls: 'meta-chip-none', label: 'no details' };
if (rec.creditRequired && !rec.credit) return { cls: 'meta-chip-bad', label: 'credit needed' };
if (!rec.alt) return { cls: 'meta-chip-none', label: 'no alt' };
return { cls: 'meta-chip-ok', label: 'details \u2713' };
}
function refreshMetaChips() {
document.querySelectorAll('.meta-chip').forEach(function(chip) {
const st = metaChipState(metaRec(chip.getAttribute('data-meta-url') || ''));
chip.className = 'meta-chip ' + st.cls;
chip.textContent = st.label;
});
}
function metaSourceOptions(sel) {
const opts = [['own', 'My own photo'], ['pexels', 'Pexels'], ['unsplash', 'Unsplash'], ['pixabay', 'Pixabay'], ['commons', 'Wikimedia Commons'], ['unknown', 'Not sure']];
return opts.map(function(o) { return '<option value="' + o[0] + '"' + (o[0] === sel ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
}
function ensureMetaModal() {
if (document.getElementById('meta-modal')) return;
const wrap = document.createElement('div');
wrap.innerHTML =
'<div class="meta-overlay" id="meta-modal">' +
'<div class="meta-card">' +
'<div class="meta-title" id="meta-title">Photo details</div>' +
'<div class="meta-sub" id="meta-sub"></div>' +
'<label class="meta-label">Alt text</label>' +
'<input type="text" class="field-input" id="meta-alt" placeholder="Describe the photo for screen readers + SEO">' +
'<label class="meta-label">Photo credit (small print under the photo)</label>' +
'<input type="text" class="field-input" id="meta-credit" placeholder="e.g. Photo: Jane Doe / CC BY-SA 4.0 via Wikimedia Commons">' +
'<label class="meta-label">Credit link (optional)</label>' +
'<input type="text" class="field-input" id="meta-credit-url" placeholder="https://... (the photo page)">' +
'<label class="meta-label">Where did this photo come from?</label>' +
'<select class="field-input" id="meta-source"></select>' +
'<label class="meta-check"><input type="checkbox" id="meta-required"> A credit is legally required for this photo</label>' +
'<div class="meta-error" id="meta-error"></div>' +
'<div class="meta-actions">' +
'<button class="btn-secondary" id="meta-cancel" type="button">Cancel</button>' +
'<button class="btn-primary" id="meta-save" type="button">Save</button>' +
'</div>' +
'<button class="meta-skip" id="meta-skip" type="button">Insert without saving details</button>' +
'</div>' +
'</div>';
document.body.appendChild(wrap.firstChild);
document.getElementById('meta-source').innerHTML = metaSourceOptions('own');
document.getElementById('meta-source').addEventListener('change', function() {
if (this.value === 'commons') document.getElementById('meta-required').checked = true;
});
document.getElementById('meta-save').addEventListener('click', metaModalSave);
document.getElementById('meta-cancel').addEventListener('click', metaModalCancel);
document.getElementById('meta-skip').addEventListener('click', metaModalSkip);
}
function openMetaModal(url, mode, range) {
ensureMetaModal();
const rec = metaRec(url);
metaModalState = { url: url, mode: mode, range: range || null };
document.getElementById('meta-alt').value = rec ? (rec.alt || '') : '';
document.getElementById('meta-credit').value = rec ? (rec.credit || '') : '';
document.getElementById('meta-credit-url').value = rec ? (rec.creditUrl || '') : '';
document.getElementById('meta-source').innerHTML = metaSourceOptions(rec ? (rec.source || 'unknown') : 'own');
document.getElementById('meta-required').checked = rec ? !!rec.creditRequired : false;
document.getElementById('meta-error').textContent = '';
const title = document.getElementById('meta-title');
const sub = document.getElementById('meta-sub');
const saveBtn = document.getElementById('meta-save');
const skipBtn = document.getElementById('meta-skip');
if (mode === 'block') {
title.textContent = 'Credit required before inserting';
sub.textContent = 'This photo is marked as needing a credit by law (for example a Wikimedia Commons CC BY / BY-SA image). Add the credit once here and it is saved for every future use.';
saveBtn.textContent = 'Save credit & insert';
skipBtn.style.display = 'none';
} else if (mode === 'prompt') {
title.textContent = 'Add photo details';
sub.textContent = 'Alt text and credit are saved once for this photo and attach automatically from now on.';
saveBtn.textContent = 'Save & insert';
skipBtn.style.display = '';
} else {
title.textContent = 'Photo details';
sub.textContent = 'Saved once for this photo; the alt attaches at insert and the credit prints under the photo on the site.';
saveBtn.textContent = 'Save';
skipBtn.style.display = 'none';
}
document.getElementById('meta-modal').classList.add('active');
}
function closeMetaModal() {
const m = document.getElementById('meta-modal');
if (m) m.classList.remove('active');
metaModalState = null;
}
function insertImageWithAlt(url, range, alt) {
if (!quill) return;
let idx = (range && typeof range.index === 'number') ? range.index : -1;
if (idx < 0) { const sel = quill.getSelection(true); idx = sel ? sel.index : quill.getLength() - 1; }
quill.insertEmbed(idx, 'image', url);
let node = null;
try {
[0, 1].forEach(function(off) {
if (node) return;
const leaf = quill.getLeaf(idx + off);
const n = leaf && leaf[0] && leaf[0].domNode;
if (n && n.tagName === 'IMG') node = n;
});
} catch (e) { /* fall through to DOM scan */ }
if (!node) {
const imgs = quill.root.querySelectorAll('img');
for (let i = 0; i < imgs.length; i++) {
if (imgs[i].getAttribute('src') === url && !imgs[i].hasAttribute('data-meta-alt')) { node = imgs[i]; break; }
}
}
if (node) { node.setAttribute('alt', alt || ''); node.setAttribute('data-meta-alt', '1'); }
markDirty();
}
async function metaModalSave() {
const st = metaModalState;
if (!st) return;
const rec = {
alt: document.getElementById('meta-alt').value.trim(),
credit: document.getElementById('meta-credit').value.trim(),
creditUrl: document.getElementById('meta-credit-url').value.trim(),
source: document.getElementById('meta-source').value,
creditRequired: document.getElementById('meta-required').checked
};
const errEl = document.getElementById('meta-error');
if (st.mode === 'block' && !rec.credit) {
errEl.textContent = 'A credit is required for this photo before it can be inserted.';
return;
}
const saved = await saveImageMeta(st.url, rec);
if (!saved && st.mode === 'block') {
errEl.textContent = 'Could not save the credit. Check your connection and try again -- the photo has not been inserted.';
return;
}
if (!saved) showToast('Photo details could not be saved', 'error');
const mode = st.mode, url = st.url, range = st.range;
closeMetaModal();
refreshMetaChips();
if (mode === 'prompt' || mode === 'block') {
insertImageWithAlt(url, range, rec.alt);
forceCloseImageManager();
}
}
function metaModalCancel() {
const st = metaModalState;
closeMetaModal();
if (st && st.mode === 'prompt') {
// The prompt is an offer, not a trap: insert with whatever the registry
// already has (possibly nothing) and let Beau move on.
const rec = metaRec(st.url);
insertImageWithAlt(st.url, st.range, rec ? (rec.alt || '') : '');
forceCloseImageManager();
}
// 'block' cancel: do not insert -- that is the point of the block.
// 'edit' cancel: just close.
}
function metaModalSkip() {
const st = metaModalState;
if (!st) return;
const rec = metaRec(st.url);
closeMetaModal();
insertImageWithAlt(st.url, st.range, rec ? (rec.alt || '') : '');
forceCloseImageManager();
}
function openMetaEditor(url) { openMetaModal(url, 'edit', null); }
function queueMetaSet(idx, field, val) {
if (!uploadQueue[idx]) return;
if (!uploadQueue[idx].meta) uploadQueue[idx].meta = { alt: '', credit: '', source: 'own' };
uploadQueue[idx].meta[field] = val;
}
function queueMetaRow(item, idx) {
if (!item.meta) item.meta = { alt: '', credit: '', source: 'own' };
return '<div class="queue-meta-row">' +
'<input type="text" class="field-input queue-meta-input" placeholder="Alt text" value="' + escAttr(item.meta.alt || '') + '" oninput="queueMetaSet(' + idx + ',\'alt\',this.value)">' +
'<input type="text" class="field-input queue-meta-input" placeholder="Credit (if not your photo)" value="' + escAttr(item.meta.credit || '') + '" oninput="queueMetaSet(' + idx + ',\'credit\',this.value)">' +
'<select class="field-input queue-meta-select" onchange="queueMetaSet(' + idx + ',\'source\',this.value)">' + metaSourceOptions(item.meta.source || 'own') + '</select>' +
'</div>';
}
// === IMAGE META SECTION END ===
function selectImage(url) {
if (imgManagerContext === 'hero') {
document.getElementById('hero-preview').src = url;
document.getElementById('f-hero-url').value = url;
document.getElementById('og-img').src = url;
const heroRec = metaRec(url);
const heroAltEl = document.getElementById('f-hero-alt');
if (heroRec && heroRec.alt && heroAltEl && !heroAltEl.value) heroAltEl.value = heroRec.alt;
markDirty();
} else if (imgManagerContext === 'quill' && quill) {
const rec = metaRec(url);
const gate = imageMetaLoaded ? insertGate(rec) : 'ok';
if (gate === 'ok') {
insertImageWithAlt(url, quill.getSelection(true), rec ? (rec.alt || '') : '');
} else {
openMetaModal(url, gate, quill.getSelection(true));
return;
}
}
forceCloseImageManager();
}
// ============================================================
// FIX 3: BATCH ZIP UPLOAD
// ============================================================
function handleBatchZip(input) {
const file = input.files[0];
if (!file) return;
input.value = '';
processBatchZip(file);
}

// Setup batch drop zone
(function setupBatchDrop() {
document.addEventListener('DOMContentLoaded', () => {
const zone = document.getElementById('batch-drop-zone');
if (!zone) return;
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
zone.addEventListener('drop', e => {
e.preventDefault();
zone.classList.remove('dragover');
const file = e.dataTransfer.files[0];
if (file && file.name.endsWith('.zip')) processBatchZip(file);
else showToast('Please drop a .zip file', 'error');
});
});
})();

async function processBatchZip(file) {
try {
showBatchScreen('drop');
showToast('Reading ZIP...', 'success');
const zip = await JSZip.loadAsync(file);
// Find posts.json
const postsFile = zip.file('posts.json');
if (!postsFile) { showToast('ZIP missing posts.json', 'error'); return; }
const postsJson = await postsFile.async('string');
let posts;
try { posts = JSON.parse(postsJson); } catch(e) { showToast('posts.json is invalid JSON', 'error'); return; }
if (!Array.isArray(posts) || !posts.length) { showToast('posts.json must be a non-empty array', 'error'); return; }
// Collect all images
const images = {};
const imgFolder = zip.folder('images');
if (imgFolder) {
for (const [relPath, zipEntry] of Object.entries(zip.files)) {
if (!zipEntry.dir && relPath.startsWith('images/')) {
images[relPath] = zipEntry;
}
}
}
batchZip = zip;
batchPosts = posts;
batchImages = images;
// Show preview
showBatchPreview(posts, images);
} catch(e) {
showToast('Failed to read ZIP: ' + e.message, 'error');
}
}

function showBatchScreen(screen) {
['drop','preview','progress','complete'].forEach(s => {
const el = document.getElementById('batch-' + s + '-screen');
if (el) el.style.display = 'none';
});
const target = document.getElementById('batch-' + screen + '-screen');
if (target) target.style.display = 'block';
}

function showBatchPreview(posts, images) {
const title = document.getElementById('batch-preview-title');
const subtitle = document.getElementById('batch-preview-subtitle');
const list = document.getElementById('batch-preview-list');
if (title) title.textContent = posts.length + ' posts found';
if (subtitle) subtitle.textContent = Object.keys(images).length + ' images in ZIP';
if (list) {
list.innerHTML = posts.map(p => {
const heroPath = p.heroImage || '';
const hasHero = heroPath && images[heroPath];
const wordCount = p.body ? p.body.replace(/<[^>]+>/g,' ').split(/\s+/).filter(Boolean).length : 0;
const parkLabel = p.park === 'dl' ? 'Disneyland' : p.park === 'wdw' ? 'WDW' : 'Both';
const parkCls = p.park === 'dl' ? 'park-dl' : p.park === 'wdw' ? 'park-wdw' : 'park-both';
return '<div class="batch-preview-card">' +
'<div class="batch-preview-thumb" style="background:#eee;display:flex;align-items:center;justify-content:center;color:#8AACAE;font-size:10px">' +
(hasHero ? '' : '&#128247;') +
'</div>' +
'<div class="batch-preview-info">' +
'<div class="batch-preview-title">' + escHtml(p.title || p.slug) + '</div>' +
'<div class="batch-preview-meta">' +
'<span class="park-pill ' + parkCls + '" style="font-size:7px;margin-right:6px">' + parkLabel + '</span>' +
wordCount + ' words' +
(!hasHero && heroPath ? ' &nbsp;&#9888; Missing hero image' : '') +
'</div>' +
'</div>' +
'</div>';
}).join('');
}
showBatchScreen('preview');
}

function resetBatch() {
batchZip = null; batchPosts = []; batchImages = {};
showBatchScreen('drop');
}

async function executeBatchUpload() {
if (!batchPosts.length) return;
showBatchScreen('progress');
const progressLabel = document.getElementById('batch-progress-label');
const progressFill = document.getElementById('batch-progress-fill');
const progressDetail = document.getElementById('batch-progress-detail');
const results = [];
// Phase 1: Upload images
const imgKeys = Object.keys(batchImages);
const imageUrlMap = {};
const filenameUrlMap = {};
for (let i = 0; i < imgKeys.length; i++) {
const relPath = imgKeys[i];
if (progressLabel) progressLabel.textContent = 'Uploading images...';
if (progressDetail) progressDetail.textContent = (i + 1) + ' of ' + imgKeys.length;
if (progressFill) progressFill.style.width = Math.round(((i + 1) / imgKeys.length) * 50) + '%';
try {
const zipEntry = batchImages[relPath];
const blob = await zipEntry.async('blob');
const filename = relPath.split('/').pop();
if (filenameUrlMap[filename]) { imageUrlMap[relPath] = filenameUrlMap[filename]; continue; }
const mimeType = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.gif') ? 'image/gif' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
const r = await fetch(API_BASE + '/api/blog-upload-image', {
method: 'POST',
headers: { 'x-admin-key': token, 'x-filename': filename, 'Content-Type': mimeType },
body: blob
});
const data = await r.json();
if (r.ok && data.url) { imageUrlMap[relPath] = data.url;
filenameUrlMap[filename] = data.url; }
else { results.push({ slug: relPath, status: 'warn', msg: 'Image upload failed: ' + relPath }); }
} catch(e) { results.push({ slug: relPath, status: 'warn', msg: 'Image error: ' + relPath }); }
}
// Phase 2: Save posts - ONE call to the batch endpoint, which writes
// every post blob first and updates the index exactly once. (The old
// per-post /api/blog-save loop ran an index read-modify-write per post;
// saves seconds apart inside the blob store's visibility lag could
// silently drop earlier posts' index entries.)
if (progressLabel) progressLabel.textContent = 'Saving posts...';
if (progressDetail) progressDetail.textContent = batchPosts.length + ' posts';
if (progressFill) progressFill.style.width = '75%';
const preparedPosts = batchPosts.map(function(raw) {
const post = { ...raw };
// Replace image paths with CDN URLs
if (post.heroImage && imageUrlMap[post.heroImage]) post.heroImage = imageUrlMap[post.heroImage];
if (post.body) {
post.body = post.body.replace(new RegExp('src="(images\\/[^"]+)"', 'g'), (m, p1) => {
return 'src="' + (imageUrlMap[p1] || p1) + '"';
});
}
// Ensure draft
post.published = false;
post.scheduledAt = null;
const now = new Date().toISOString();
if (!post.publishedAt) post.publishedAt = now;
post.updatedAt = now;
// Set defaults for missing fields
const parkLabels = { dl: 'Disneyland', wdw: 'Walt Disney World', both: 'Both Resorts' };
if (!post.category) post.category = (parkLabels[post.park] || 'Guide') + ' &middot; Guide';
if (!post.tagLabel) post.tagLabel = parkLabels[post.park] || post.park;
if (!post.cta) post.cta = { type: post.park || 'dl', text: 'Get the Theme Park Co-Pilot app.', buttonText: 'Try free for 7 days &#8594;', buttonUrl: 'https://themeparkcopilot.com' };
return post;
});
let saved = 0, failed = 0;
try {
const r = await fetch(API_BASE + '/api/blog-batch-save', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify({ posts: preparedPosts })
});
const data = await r.json();
if (r.ok && data.success && Array.isArray(data.results)) {
data.results.forEach(function(item) {
const src = preparedPosts.find(p => p.slug === item.slug);
if (item.status === 'ok') { saved++; results.push({ slug: item.slug, status: 'ok', msg: (src && src.title) || item.slug }); }
else { failed++; results.push({ slug: item.slug, status: 'err', msg: 'Save failed: ' + (item.error || item.slug) }); }
});
if (data.indexUpdated === false) {
results.push({ slug: '(index)', status: 'warn', msg: 'Posts saved, but the index update was refused (' + (data.indexError || 'conflict') + '). Re-run the import or ask for a reindex repair - the daily check will also flag it.' });
}
if (data.indexUpdated !== false) {
data.results.forEach(function(item) {
if (item.status === 'ok') {
const srcPost = preparedPosts.find(p => p.slug === item.slug);
if (srcPost) optimisticUpsert(item.slug, toOptimisticEntry(srcPost, allPosts.find(function(p) { return p.slug === item.slug; })));
}
});
}
} else {
failed = batchPosts.length;
results.push({ slug: '(batch)', status: 'err', msg: 'Batch save failed: ' + ((data && data.error) || ('HTTP ' + r.status)) });
}
} catch(e) {
failed = batchPosts.length;
results.push({ slug: '(batch)', status: 'err', msg: 'Error saving batch: ' + e.message });
}
// Show completion
if (progressFill) progressFill.style.width = '100%';
await loadPosts();
showBatchScreen('complete');
const completeLabel = document.getElementById('batch-complete-label');
const completeSub = document.getElementById('batch-complete-sub');
const completeResults = document.getElementById('batch-complete-results');
if (completeLabel) completeLabel.textContent = saved + ' post' + (saved !== 1 ? 's' : '') + ' saved to Drafts';
if (completeSub) completeSub.textContent = (failed ? failed + ' failed. ' : '') + (Object.keys(imageUrlMap).length) + ' images uploaded.';
if (completeResults) {
completeResults.innerHTML = results.map(r => {
const icon = r.status === 'ok' ? '&#10003;' : r.status === 'warn' ? '&#9888;' : '&#10007;';
const cls = r.status === 'ok' ? 'batch-result-ok' : r.status === 'warn' ? 'batch-result-warn' : 'batch-result-err';
return '<div class="batch-result-item ' + cls + '"><span>' + icon + '</span><span>' + escHtml(r.msg) + '</span></div>';
}).join('');
}
}
// ============================================================
// ============================================================
// AUTO-GENERATE TAGS
// ============================================================
async function autoGenerateTags() {
const btn = document.getElementById('btn-auto-tags');
btn.textContent = 'Generating...';
btn.disabled = true;
try {
const title = document.getElementById('f-title').value || '';
const intro = document.getElementById('f-intro').value || '';
const body = (quill ? quill.getText() : '').substring(0, 500);

const adminPw = sessionStorage.getItem('tpcp_admin_pw') || '';
const res = await fetch(API_BASE + '/api/ai', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'x-admin-key': adminPw
},
body: JSON.stringify({
prompt: 'Generate 8-12 SEO keyword tags for this blog post. Return ONLY a comma-separated list of tags, nothing else. Title: ' + title + '. Intro: ' + intro + '. Body: ' + body
})
});
const data = await res.json();
console.log('AI response:', data);
const rawText = data.text || data.response || data.reply || data.answer || '';
const tags = rawText.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
if (tags.length) {
document.getElementById('f-tags').value = tags.join(', ');
showToast('Tags generated!', 'success');
} else {
console.error('No tags parsed from:', data);
showToast('No tags returned ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ check console', 'error');
}
} catch(e) {
console.error('autoGenerateTags error:', e);
showToast('AI generation failed: ' + e.message, 'error');
} finally {
btn.textContent = 'Auto-generate tags';
btn.disabled = false;
}
}

// ============================================================
// VIDEO EMBED
// ============================================================
function openVideoModal() {
document.getElementById('video-url-input').value = '';
document.getElementById('video-modal').style.display = 'flex';
setTimeout(function() { document.getElementById('video-url-input').focus(); }, 100);
}

function closeVideoModal() {
document.getElementById('video-modal').style.display = 'none';
}

function getVideoEmbed(url) {
// YouTube
var ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
if (ytMatch) {
return '<div class="video-embed"><iframe src="https://www.youtube.com/embed/' + ytMatch[1] + '" frameborder="0" allowfullscreen loading="lazy"></iframe></div>';
}
// Instagram
if (url.indexOf('instagram.com') !== -1) {
var igUrl = url.split('?')[0].replace(/\/$/, '');
return '<div class="video-embed"><blockquote class="instagram-media" data-instgrm-permalink="' + igUrl + '/" data-instgrm-version="14"></blockquote><script async src="//www.instagram.com/embed.js"><\/script></div>';
}
// TikTok
var ttMatch = url.match(/tiktok\.com\/@[^\/]+\/video\/(\d+)/);
if (ttMatch) {
return '<div class="video-embed"><blockquote class="tiktok-embed" cite="' + url + '" data-video-id="' + ttMatch[1] + '"><section></section></blockquote><script async src="https://www.tiktok.com/embed.js"><\/script></div>';
}
// Twitter/X
var twMatch = url.match(/(?:twitter|x)\.com\/[^\/]+\/status\/(\d+)/);
if (twMatch) {
return '<div class="video-embed"><blockquote class="twitter-tweet"><a href="' + url + '"></a></blockquote><script async src="https://platform.twitter.com/widgets.js"><\/script></div>';
}
// Facebook
if (url.indexOf('facebook.com') !== -1) {
return '<div class="video-embed"><iframe src="https://www.facebook.com/plugins/video.php?href=' + encodeURIComponent(url) + '&show_text=false" frameborder="0" allowfullscreen loading="lazy"></iframe></div>';
}
return null;
}

function insertVideo() {
var url = (document.getElementById('video-url-input').value || '').trim();
if (!url) return;
var embed = getVideoEmbed(url);
if (!embed) {
showToast('Unsupported URL. Try YouTube, Instagram, TikTok, Facebook, or Twitter/X.', 'error');
return;
}
var range = quill.getSelection(true);
quill.clipboard.dangerouslyPasteHTML(range ? range.index : quill.getLength(), embed);
markDirty();
closeVideoModal();
showToast('Video embedded!', 'success');
}

// ============================================================
// UTILS
// ============================================================
function showToast(msg, type) {
const t = document.createElement('div');
t.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
t.innerHTML = msg;
document.body.appendChild(t);
setTimeout(() => t.remove(), 2200);
}

function escHtml(s) {
return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

document.addEventListener('change', e => {
if (e.target && e.target.id === 'f-published') {
document.getElementById('status-label').textContent = e.target.checked ? 'Published' : 'Draft';
const schedulBtn = document.getElementById('btn-schedule');
if (schedulBtn) schedulBtn.style.display = e.target.checked ? 'none' : (currentPost ? 'block' : 'none');
}
});
