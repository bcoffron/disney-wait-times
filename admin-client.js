

// ============================================================
// STATE
// ============================================================
const API_BASE = '';
let token = sessionStorage.getItem('tpcp_admin_token') || '';
let allPosts = [];
let featuredSlug = null;
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
let _deleteInUseSafeUrls = null;
let _deleteFromView = null;

// IMAGE SELECTION state
let imgSelectMode = false;
let selectedImgUrls = new Set();
var allUsedUrls = new Set();
var pinnedSlugs = [];

// ============================================================
// NORMALIZE URL (module-level so deleteImage and loadImagesInline can both use it)
// ============================================================
function normalizeUrl(url) {
  try {
    var u = new URL(url);
    u.search = '';
    return u.href.toLowerCase().replace(/\/$/, '');
  } catch(e) {
    return (url || '').toLowerCase().replace(/\/$/, '');
  }
}

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
      loginFailures++;
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (token) showApp();
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
function initQuill() {
  if (quill) return;
  const toolbarOptions = {
    container: [
      [{ 'header': 2 }],
      ['bold', 'italic'],
      [{ 'list': 'ordered' }, { 'list': 'bullet' }],
      ['link', 'image'],
      ['undo', 'redo']
      ],
    handlers: {
      image: function() { openImageManager('quill'); },
      undo: function() { if (quill) quill.history.undo(); },
      redo: function() { if (quill) quill.history.redo(); }
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
  // Add video embed button manually to avoid blank toolbar gaps
const quillToolbar = quill.getModule('toolbar');
  quillToolbar.addHandler('video-embed', openVideoModal);
  const toolbarEl = document.querySelector('.ql-toolbar');
  if (toolbarEl) {
    const videoBtn = document.createElement('button');
    videoBtn.className = 'ql-video-embed';
    videoBtn.title = 'Embed Video';
    videoBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/><polygon points="10,8 16,12 10,16"/></svg>';
    videoBtn.addEventListener('click', openVideoModal);
    var imageBtn = document.querySelector('.ql-toolbar .ql-image');
    if (imageBtn) {
      var imageGroup = imageBtn.closest('.ql-formats');
      if (imageGroup) {
        imageGroup.appendChild(videoBtn);
      } else {
        toolbarEl.appendChild(videoBtn);
      }
    } else {
      toolbarEl.appendChild(videoBtn);
    }
  }
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
async function loadPosts() {
  try {
    const r = await fetch(API_BASE + '/api/blog-index');
    allPosts = await r.json();
    cachedPosts = allPosts;
    if (!Array.isArray(allPosts)) allPosts = [];
    try { const fr = await fetch(API_BASE + '/api/blog-feature'); if (fr.ok) { const fd = await fr.json(); featuredSlug = fd.featuredSlug || null; } } catch(e) { featuredSlug = null; }
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
'<div class="post-row" onclick="openPost(' + q + fp.slug + q + ')" style="background:#FFFBF0;border-left:3px solid #ECA050">' +
'<img class="post-thumb" src="' + (fp.heroImage||'') + '" alt="">' +
'<span class="post-title-cell">' + escHtml(fp.title||'Untitled') + '</span>' +
'<span class="park-pill ' + fpParkCls + '">' + fpParkLabel + '</span>' +
'<span class="post-date">' + fpDate + '</span>' +
'<span style="background:#F59E0B;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;margin-right:4px">FEATURED</span>' +
'<div class="post-actions" onclick="event.stopPropagation()">' +
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
return '<div class="post-row" onclick="openPost(' + q + p.slug + q + ')" style="border-left:3px solid #1A6860">' +
'<img class="post-thumb" src="' + (p.heroImage||'') + '" alt="" loading="lazy" onerror="this.src=' + q + q + '">' +
'<span class="post-title-cell">' + escHtml(p.title||'Untitled') + ' <span style="font-size:11px;color:#F59E0B" title="Pinned #' + (pinIdx+1) + '">&#128204;</span></span>' +
'<span class="park-pill ' + parkCls + '">' + parkLabel + '</span>' +
'<span class="post-date">' + date + '</span>' +
'<div class="post-actions" onclick="event.stopPropagation()">' +
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
const pinDisabled = atLimit ? 'disabled title="Maximum pins reached ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ unpin a post above first" style="opacity:0.4;cursor:not-allowed"' : 'title="Pin to top of blog"';
return '<div class="post-row" onclick="openPost(' + q + p.slug + q + ')">' +
'<img class="post-thumb" src="' + (p.heroImage||'') + '" alt="" loading="lazy" onerror="this.src=' + q + q + '">' +
'<span class="post-title-cell">' + escHtml(p.title||'Untitled') + '</span>' +
'<span class="park-pill ' + parkCls + '">' + parkLabel + '</span>' +
'<span class="status-pill ' + statusCls + '">' + statusLabel + '</span>' +
'<span class="post-date">' + date + '</span>' +
'<div class="post-actions" onclick="event.stopPropagation()">' +
'<button type="button" class="btn-edit" onclick="openPost(' + q + p.slug + q + ')">Edit</button>' +
'<button type="button" class="btn-feat" onclick="featurePost(' + q + p.slug + q + ')">' + (featuredSlug === p.slug ? '&#128204;' : 'Feature') + '</button>' +
'<button type="button" class="btn-edit" ' + pinDisabled + ' onclick="togglePin(' + q + p.slug + q + ')">&#128204; Pin</button>' +
'<button type="button" class="btn-del" onclick="quickDelete(' + q + p.slug + q + ')">Delete</button>' +
'</div></div>';
}).join('');
}


table.innerHTML = featuredSection + pinnedHeader + pinnedRows + allPostsHeader + allRows;
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
return '<div class="post-row">' +
'<img class="post-thumb" src="' + (p.heroImage||'') + '" alt="" loading="lazy" onerror="this.src=' + q + q + '">' +
'<span class="post-title-cell">' + escHtml(p.title||'Untitled') + '</span>' +
'<span class="park-pill ' + parkCls + '">' + parkLabel + '</span>' +
'<span class="status-pill ' + statusCls + '">' + statusLabel + '</span>' +
'<span class="post-date">' + date + '</span>' +
'<div class="post-actions">' +
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
const r = await fetch(API_BASE + '/api/blog-post?slug=' + encodeURIComponent(slug));
if (!r.ok) { showToast('Could not load draft', 'error'); return; }
const post = await r.json();
post.published = true;
post.updatedAt = new Date().toISOString();
const saveR = await fetch(API_BASE + '/api/blog-save', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify(post)
});
const data = await saveR.json();
if (saveR.ok && data.success) {
showToast('Published \u2713', 'success');
await loadPosts();
renderDraftsList();
} else { showToast('Publish failed', 'error'); }
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
    const isCurrentlyFeatured = featuredSlug === slug;
    const newSlug = isCurrentlyFeatured ? null : slug;
    const res = await fetch(API_BASE + '/api/blog-feature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
      body: JSON.stringify({ slug: newSlug })
    });
    const data = await res.json();
    if (data.success) {
      featuredSlug = newSlug;
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
const r = await fetch(API_BASE + '/api/blog-post?slug=' + encodeURIComponent(slug));
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
if (post) related.push({ slug: post.slug, park: post.park, title: post.title });
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
const btn = document.getElementById('btn-publish');
const origText = btn.textContent;
btn.textContent = 'Saving...';
btn.classList.add('btn-loading');
btn.disabled = true;

if (!post.slug) { showToast('Slug is required', 'error'); btn.textContent = origText; btn.classList.remove('btn-loading'); btn.disabled = false; return; }
try {
const r = await fetch(API_BASE + '/api/blog-save', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify(post)
});
const data = await r.json();
if (r.ok && data.success) {
currentPost = post;
isDirty = false;
document.getElementById('f-readtime').value = post.readTime;
document.getElementById('f-published').checked = post.published;
document.getElementById('status-label').textContent = post.published ? 'Published' : 'Draft';
document.getElementById('btn-delete-post').style.display = 'block';
// Hide schedule button after publishing
if (post.published) document.getElementById('btn-schedule').style.display = 'none';
showToast(post.published ? 'Published &#10003;' : 'Saved &#10003;', 'success');
await loadPosts();
      if (post.published && document.getElementById('images-view') && document.getElementById('images-view').style.display !== 'none') { loadImagesInline(); }
} else { showToast('Save failed &mdash; try again', 'error'); }
} catch(e) { showToast('Save failed &mdash; try again', 'error'); }
finally { btn.textContent = origText; btn.classList.remove('btn-loading'); btn.disabled = false; }
}

function goLive() {
  const post = collectPost();
  post.published = true;
  post.publishedAt = new Date().toISOString(); // always fresh on Go Live
  post.updatedAt = new Date().toISOString();
  post.scheduledAt = null;
  savePost(post);
}
// ============================================================
function updatePost() { console.log('updatePost called, currentPost.publishedAt:', currentPost && currentPost.publishedAt); const post = collectPost(); post.published = true; post.publishedAt = currentPost && currentPost.publishedAt ? currentPost.publishedAt : post.publishedAt; post.updatedAt = new Date().toISOString(); savePost(post); }
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
if (warning) { warning.textContent = 'Large PNG detected ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ consider JPG for faster load'; warning.style.display = 'block'; }
}
try {
const r = await fetch(API_BASE + '/api/blog-upload-image', {
method: 'POST',
headers: { 'x-admin-key': token, 'x-filename': item.file.name, 'Content-Type': item.file.type },
body: item.file
});
const data = await r.json();
if (r.ok && data.url) { successCount++; }
else { progress.textContent = 'Failed: ' + item.file.name; progress.style.color = '#C82030'; await sleep(1000); progress.style.color = '#0A4840'; }
} catch(e) { progress.textContent = 'Upload error: ' + item.file.name; progress.style.color = '#C82030'; await sleep(1000); progress.style.color = '#0A4840'; }
}
progress.textContent = successCount + ' of ' + total + ' uploaded \u2713';
uploadQueue = [];
uploadDone = true;
renderUploadQueue();
}

// Alias
async function startUploadQueue() { await uploadQueue_fn(); }

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function loadImages() {
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
'<button class="img-cell-btn danger" onclick="event.stopPropagation();deleteImage(' + "'" + escAttr(img.url) + "'" + ')">Delete</button>' +
'</div>' : '') +
'</div>' +
'<div class="img-cell-name">' + escHtml(img.filename) + '</div>' +
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

function isImageInUse(url) {
return allPosts.some(function(p) { return p.heroImage === url || (p.body && p.body.indexOf(url) >= 0); });
}
function getPostsUsingImage(url) {
return allPosts.filter(function(p) { return p.heroImage === url || (p.body && p.body.indexOf(url) >= 0); });
}

function deleteImage(url) {
  console.log('deleteImage called:', url);
  console.log('allUsedUrls size:', allUsedUrls.size);
  console.log('normalizeUrl result:', normalizeUrl(url));
  console.log('isUsed:', allUsedUrls.has(normalizeUrl(url)));
  if (imgSelectMode) return;
  if (allUsedUrls.has(normalizeUrl(url))) {
    showImageDeleteWarning(url);
    return;
  }
  confirmDeleteImage(url);
}

function showImageDeleteWarning(url) {
  const modal = document.getElementById('img-in-use-modal');
  const bodyEl = document.getElementById('img-in-use-body');
  if (bodyEl) bodyEl.textContent = 'This image is used in a live post. Deleting it will break that post\'s image.';
  document.getElementById('img-in-use-multi-actions').style.display = 'none';
  document.getElementById('img-in-use-single-actions').style.display = 'flex';
  // Repurpose the single-action buttons for this simpler confirm flow
  const deleteAnywayBtn = document.getElementById('img-in-use-delete-anyway');
  const moveToUsedBtn = document.getElementById('img-in-use-move');
  const cancelBtn = document.getElementById('img-in-use-cancel');
  // Override onclick for these buttons
  if (deleteAnywayBtn) deleteAnywayBtn.onclick = function() { closeModal('img-in-use-modal'); confirmDeleteImage(url); };
  if (moveToUsedBtn) moveToUsedBtn.onclick = function() { closeModal('img-in-use-modal'); };
  if (cancelBtn) cancelBtn.onclick = function() { closeModal('img-in-use-modal'); };
  modal.classList.add('active');
}

async function confirmDeleteImage(url) {
  try {
    const r = await fetch(API_BASE + '/api/blog-images', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
      body: JSON.stringify({ url })
    });
    if (r.ok) loadImagesInline();
    else showToast('Delete failed', 'error');
  } catch(e) { showToast('Delete failed', 'error'); }
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
const urls = Array.from(selectedImgUrls);
// Check which ones are in use
const inUseUrls = urls.filter(u => isImageInUse(u));
const safeUrls = urls.filter(u => !isImageInUse(u));
if (inUseUrls.length > 0) {
// Show grouped warning
confirmMultiDeleteInUse(inUseUrls, safeUrls);
return;
}
// All safe -- delete immediately
await _doMultiDelete(urls);
}

async function _doMultiDelete(urls) {
const btn = document.getElementById('btn-delete-selected');
if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }
let failed = 0;
for (const url of urls) {
try {
const r = await fetch(API_BASE + '/api/blog-images', {
method: 'DELETE',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify({ url })
});
if (!r.ok) failed++;
} catch(e) { failed++; }
}
if (failed) showToast(failed + ' deletion(s) failed', 'error');
else showToast('Deleted ' + urls.length + ' image' + (urls.length !== 1 ? 's' : ''), 'success');
exitSelectMode();
await loadImagesInline();
}

function confirmDeleteInUse(url) {
_deleteInUseUrl = url;
const posts = getPostsUsingImage(url);
const postList = posts.map(p => escHtml(p.title || p.slug)).join(', ');
const bodyEl = document.getElementById('img-in-use-body');
if (bodyEl) bodyEl.textContent = 'This image is used in: ' + postList + '. Deleting it will permanently remove it from that post. Move to Used Photos to keep it accessible without cluttering the library.';
document.getElementById('img-in-use-multi-actions').style.display = 'none';
document.getElementById('img-in-use-single-actions').style.display = 'flex';
document.getElementById('img-in-use-modal').classList.add('active');
}
function confirmMultiDeleteInUse(inUseUrls, safeUrls) {
_deleteInUseMultiUrls = inUseUrls;
_deleteInUseSafeUrls = safeUrls;
const postTitles = [];
inUseUrls.forEach(url => {
getPostsUsingImage(url).forEach(p => {
const t = p.title || p.slug;
if (postTitles.indexOf(t) < 0) postTitles.push(t);
});
});
const bodyEl = document.getElementById('img-in-use-body');
if (bodyEl) bodyEl.textContent = inUseUrls.length + ' of your selected images are used in posts: ' + postTitles.map(t => escHtml(t)).join(', ') + '. What would you like to do with them?';
document.getElementById('img-in-use-multi-actions').style.display = 'flex';
document.getElementById('img-in-use-single-actions').style.display = 'none';
document.getElementById('img-in-use-modal').classList.add('active');
}
async function deleteInUseAnyway() {
const url = _deleteInUseUrl;
_deleteInUseUrl = null;
closeModal('img-in-use-modal');
if (!url) return;
try {
const r = await fetch(API_BASE + '/api/blog-images', {
method: 'DELETE',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify({ url })
});
if (r.ok) {
const affectedPosts = allPosts.filter(p => p.heroImage === url || (p.body && p.body.indexOf(url) >= 0));
for (const postMeta of affectedPosts) {
try {
const pr = await fetch(API_BASE + '/api/blog-post?slug=' + encodeURIComponent(postMeta.slug));
if (!pr.ok) continue;
const post = await pr.json();
let changed = false;
if (post.heroImage === url) { post.heroImage = ''; changed = true; }
if (post.body && post.body.indexOf(url) >= 0) {
let b = post.body, idx = 0;
while ((idx = b.indexOf(url, idx)) >= 0) {
const tagStart = b.lastIndexOf('<img', idx);
const tagEnd = b.indexOf('>', idx) + 1;
if (tagStart >= 0 && tagEnd > 0) { b = b.slice(0, tagStart) + b.slice(tagEnd); idx = tagStart; } else { idx++; }
}
post.body = b; changed = true;
}
if (changed) {
post.updatedAt = new Date().toISOString();
await fetch(API_BASE + '/api/blog-save', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify(post)
});
}
} catch(pe) {}
}
if (affectedPosts.length) { await loadPosts(); }
showToast('Deleted', 'success');
loadImagesInline();
} else showToast('Delete failed', 'error');
} catch(e) { showToast('Delete failed', 'error'); }
}
function moveMultiToUsedPhotos() {
const inUseUrls = _deleteInUseMultiUrls || [];
const grid = document.getElementById('lib-img-grid');
if (grid) {
inUseUrls.forEach(url => {
grid.querySelectorAll('.img-cell').forEach(cell => { if (cell.dataset.url === url) cell.remove(); });
});
}
const safeUrls = _deleteInUseSafeUrls || [];
_deleteInUseMultiUrls = null; _deleteInUseSafeUrls = null;
closeModal('img-in-use-modal');
exitSelectMode();
if (safeUrls.length > 0) {
_doMultiDelete(safeUrls).then(() => {
showToast('In-use images moved to Used Photos', 'success');
loadImagesInline();
});
} else {
showToast('In-use images moved to Used Photos', 'success');
}
}

async function deleteMultiAnyway() {
const inUseUrls = _deleteInUseMultiUrls || [];
const safeUrls = _deleteInUseSafeUrls || [];
_deleteInUseMultiUrls = null; _deleteInUseSafeUrls = null;
closeModal('img-in-use-modal');
exitSelectMode();
await _doMultiDelete([...inUseUrls, ...safeUrls]);
}

async function loadImagesInline() {
  const q = "'";
  const grid = document.getElementById('images-inline-grid');
  const usedSection = document.getElementById('used-photos-section');
  const usedGrid = document.getElementById('used-photos-grid');
  grid.innerHTML = '<div style="color:#8AACAE;font-size:13px">Loading...</div>';
  if (usedSection) usedSection.style.display = 'none';


  // Fetch library images and ALL posts in parallel
  let images = [], publishedPosts = [];
  try {
    const [libRes, idxRes] = await Promise.all([
      fetch(API_BASE + '/api/blog-images', { headers: { 'x-admin-key': token } }),
      fetch(API_BASE + '/api/blog-index')
    ]);
    images = libRes.ok ? await libRes.json() : [];
    if (!images || images.length === 0) return; // don't wipe library on failed fetch
    const allIdx = idxRes.ok ? await idxRes.json() : [];
    publishedPosts = Array.isArray(allIdx) ? allIdx.filter(p => p.published) : [];
  } catch(e) {
    grid.innerHTML = '<div style="color:#C82030;font-size:13px">Failed to load images.</div>';
    return;
  }

  allUsedUrls = new Set();
  const fullPosts = []; // cache full post objects for Used Photos section
  // Fetch individual post bodies in batches of 5 to avoid rate limiting
  // Process in batches of 5 to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < publishedPosts.length; i += batchSize) {
    const batch = publishedPosts.slice(i, i + batchSize);
    await Promise.all(batch.map(async function(p) {
      try {
        const res = await fetch(API_BASE + '/api/blog-post?slug=' + p.slug);
        if (!res.ok) return;
        const post = await res.json();
        var bodyImgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
        var match;
        while ((match = bodyImgRegex.exec(post.body || '')) !== null) {
          allUsedUrls.add(normalizeUrl(match[1]));
        }
        if (post.heroImage) allUsedUrls.add(normalizeUrl(post.heroImage));
        fullPosts.push(post); // save full post for Used Photos section
      } catch(e) {}
    }));
    // Small delay between batches
    await new Promise(r => setTimeout(r, 200));
  }

  
  // Render library grid ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ show ONLY images NOT currently in use (normalized comparison)
  if (!images.length) {
    grid.innerHTML = '<div class="coming-soon">No images yet. Use Upload Image above.</div>';
    updateSelectBar();
  } else {
    const unusedImages = images.filter(img => !allUsedUrls.has(normalizeUrl(img.url)));

    if (unusedImages.length === 0) {
      grid.innerHTML = '<div class="coming-soon">All uploaded images are currently in use.</div>';
    } else {
      grid.innerHTML = '<div class="img-grid" id="lib-img-grid">' + unusedImages.map(img => {
        const isSel = selectedImgUrls.has(img.url);
        return '<div class="img-cell' + (isSel ? ' selected' : '') + '" style="position:relative" data-url="' + escAttr(img.url) + '" onclick="imgCellClick(event,this,' + "'" + escAttr(img.url) + "'" + ')">' +
          '<div class="img-cell-check"></div>' +
          '<div class="img-cell-wrap">' +
          '<img src="' + escAttr(img.url) + '" alt="' + escAttr(img.filename) + '" loading="lazy">' +
          '<div class="img-cell-actions">' +
          '<button class="img-cell-btn" onclick="event.stopPropagation();copyImgUrl(' + "'" + escAttr(img.url) + "',this" + ')">Copy URL</button>' +
          '<button class="img-cell-btn danger" onclick="event.stopPropagation();deleteImage(' + "'" + escAttr(img.url) + "'" + ')">Delete</button>' +
          '</div>' +
          '</div>' +
          '<div class="img-cell-name">' + escHtml(img.filename) + '</div>' +
          '</div>';
      }).join('') + '</div>';
    }
    updateSelectBar();

    // Build Used Photos: ALL images referenced in any live post (normalized dedup)
    const usedEntries = [];
    const seenNormalized = new Set();

    for (const post of fullPosts) {
      const postTitle = post.title || post.slug || 'Untitled';
      // Hero image
      if (post.heroImage) {
        const norm = normalizeUrl(post.heroImage);
        if (!seenNormalized.has(norm)) {
          seenNormalized.add(norm);
          usedEntries.push({ url: post.heroImage, postTitle });
        }
      }
      // Body images ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ robust regex catches all formats
      var bodyImgRegex2 = /<img[^>]+src=["']([^"']+)["']/gi;
      var match2;
      while ((match2 = bodyImgRegex2.exec(post.body || '')) !== null) {
        const imgUrl = match2[1];
        const norm = normalizeUrl(imgUrl);
        if (!seenNormalized.has(norm)) {
          seenNormalized.add(norm);
          usedEntries.push({ url: imgUrl, postTitle });
        }
      }
    }

    if (usedEntries.length > 0 && usedSection && usedGrid) {
      usedSection.style.display = 'block';
      usedGrid.innerHTML = usedEntries.map(entry =>
        '<div class="used-photo-cell" style="position:relative">' +
        '<div class="img-cell-wrap">' +
        '<img src="' + escAttr(entry.url) + '" alt="' + escAttr(entry.postTitle) + '" loading="lazy" title="' + escAttr(entry.postTitle) + '" style="width:100%;height:100%;object-fit:cover;display:block">' +
        '<div class="img-cell-actions">' +
        '<button class="img-cell-btn" onclick="event.stopPropagation();copyImgUrl(' + "'" + escAttr(entry.url) + "',this" + ')">Copy URL</button>' +
        '</div>' +
        '</div>' +
        '<div class="used-photo-title" title="' + escAttr(entry.postTitle) + '">' + escHtml(entry.postTitle) + '</div>' +
        '</div>'
      ).join('');
    } else if (usedSection) {
      usedSection.style.display = 'none';
    }
  }
}
function selectImage(url) {
if (imgManagerContext === 'hero') {
document.getElementById('hero-preview').src = url;
document.getElementById('f-hero-url').value = url;
document.getElementById('og-img').src = url;
markDirty();
} else if (imgManagerContext === 'quill' && quill) {
const range = quill.getSelection(true);
quill.insertEmbed(range.index, 'image', url);
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
// Phase 2: Save posts
if (progressFill) progressFill.style.width = '50%';
let saved = 0, failed = 0;
for (let i = 0; i < batchPosts.length; i++) {
const post = { ...batchPosts[i] };
if (progressLabel) progressLabel.textContent = 'Saving posts...';
if (progressDetail) progressDetail.textContent = (i + 1) + ' of ' + batchPosts.length;
if (progressFill) progressFill.style.width = (50 + Math.round(((i + 1) / batchPosts.length) * 50)) + '%';
// Replace image paths with CDN URLs
if (post.heroImage && imageUrlMap[post.heroImage]) post.heroImage = imageUrlMap[post.heroImage];
if (post.body) {
post.body = post.body.replace(new RegExp('src="(images\/[^"]+)"', 'g'), (m, p1) => {
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
try {
const r = await fetch(API_BASE + '/api/blog-save', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
body: JSON.stringify(post)
});
const data = await r.json();
if (r.ok && data.success) { saved++; results.push({ slug: post.slug, status: 'ok', msg: post.title || post.slug }); }
else { failed++; results.push({ slug: post.slug, status: 'err', msg: 'Save failed: ' + (post.title || post.slug) }); }
} catch(e) { failed++; results.push({ slug: post.slug, status: 'err', msg: 'Error saving: ' + (post.title || post.slug) }); }
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
showToast('No tags returned ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ check console', 'error');
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
