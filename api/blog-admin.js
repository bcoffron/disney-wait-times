// ============================================================
// blog-admin.js — HTML SHELL ONLY
// ============================================================
// JS lives in: admin-client.js (served via /api/admin-js → /admin-client.js)
// CSS lives in: admin-client.css (served via /api/admin-css → /admin-client.css)
// Edit JS/CSS in those files — no escaping constraints there.
// This file only contains the HTML structure.
// ============================================================
export default function handler(req, res) {
res.setHeader('Content-Type', 'text/html; charset=utf-8');
res.setHeader('Cache-Control', 'no-store');
res.status(200).send(ADMIN_HTML);
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Theme Park Co-Pilot &mdash; Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link href="https://cdn.quilljs.com/1.3.7/quill.snow.css" rel="stylesheet">
<script src="https://cdn.quilljs.com/1.3.7/quill.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"><\/script>
<link rel="stylesheet" href="/admin-client.css">
<\/head>
<body>
<!-- MOBILE MENU BUTTON -->
<button class="mobile-menu-btn" onclick="document.querySelector('.sidebar').classList.toggle('open')" aria-label="Menu">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/><\/svg>
<\/button>

<!-- LOGIN SCREEN -->
<div id="login-screen">
<div class="login-card">
<div class="login-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt=""><\/div>
<div class="login-label">Admin<\/div>
<div class="login-wordmark">Theme Park Co<span style="color:#ECA050">&#10022;<\/span>Pilot<\/div>
<input type="password" class="login-input" id="pw-input" placeholder="Admin password" autocomplete="current-password">
<button class="login-btn" id="login-btn" onclick="doLogin()">Enter<\/button>
<div class="login-error" id="login-error"><\/div>
<\/div>
<\/div>

<!-- MAIN APP -->
<div id="app">
<!-- Sidebar -->
<nav class="sidebar" id="sidebar">
<div class="sidebar-top">
<div class="sidebar-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt=""><\/div>
<div class="sidebar-wordmark">Theme Park<br>Co<span style="color:#ECA050">&#10022;<\/span>Pilot<\/div>
<\/div>
<div class="sidebar-nav">
<button class="nav-item active" id="nav-posts" onclick="showView('posts')">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"/><\/svg>
Live Posts <span class="nav-badge" id="posts-badge">0<\/span>
<\/button>
<button class="nav-item" id="nav-new" onclick="openNewPost()">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"/><\/svg>
New Post
<\/button>
<button class="nav-item" id="nav-drafts" onclick="showView('drafts')">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z"/><\/svg>
Drafts <span class="nav-badge-draft" id="drafts-badge">0<\/span>
<\/button>

<button class="nav-item" id="nav-images" onclick="showView('images')">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/><\/svg>
Image Library
<\/button>
<button class="nav-item" id="nav-settings" onclick="showView('settings')">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/><\/svg>
Settings
<\/button>
<button class="nav-item" id="nav-batch" onclick="showView('batch')">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z"/><\/svg>
Batch Upload
<\/button>
<\/div>
<div class="sidebar-bottom">
<button class="logout-btn" onclick="doLogout()">Sign out<\/button>
<\/div>
<\/nav>
<!-- Main area -->
<main class="main-content">
<!-- Posts list view -->
<div id="posts-view">
<div class="posts-header">
<h1 class="posts-title">Live Posts<\/h1>
<button class="btn-new-post" onclick="openNewPost()">+ New Post<\/button>
<\/div>
<input type="text" class="search-input" placeholder="Search posts..." oninput="filterPosts(this.value)">
<div class="posts-table" id="posts-table"><\/div>
<\/div>

<!-- Drafts list view -->
<div id="drafts-view" style="display:none">
<div class="posts-header">
<h1 class="posts-title">Drafts<\/h1>
<button class="btn-new-post" onclick="openNewPost()">+ New Post<\/button>
<\/div>
<input type="text" class="search-input" placeholder="Search drafts..." oninput="filterDrafts(this.value)" style="margin-bottom:8px">
<div class="posts-table" id="drafts-table"><\/div>
<\/div>

<!-- Editor view -->
<div id="editor-view">
<button class="editor-back" onclick="cancelEdit()">
<span id="editor-back-label">← Back to Posts<\/span>
<\/button>
<div class="editor-panels">
<div class="editor-left">
<div class="field-group">
<div class="field-label">Title<\/div>
<input type="text" class="field-input title-input" id="f-title" placeholder="Post title" oninput="onTitleChange();markDirty()">
<\/div>
<div class="field-group">
<div class="field-label">Slug<\/div>
<input type="text" class="field-input" id="f-slug" placeholder="post-slug" oninput="updatePreviews();markDirty()">
<div class="slug-preview" id="slug-preview">themeparkcopilot.com/blog/<\/div>
<\/div>
<div class="field-group">
<div class="field-label">Park<\/div>
<select class="field-select" id="f-park" onchange="markDirty()">
<option value="dl">Disneyland<\/option>
<option value="wdw">Walt Disney World<\/option>
<option value="both">Both Resorts<\/option>
<\/select>
<\/div>
<div class="field-group">
<div class="field-label">Meta Description<\/div>
<textarea class="field-textarea" id="f-meta" rows="3" placeholder="Meta description..." oninput="onMetaChange();markDirty()"><\/textarea>
<div class="meta-counter" id="meta-counter">0 / 160<\/div>
<\/div>
<div class="field-group">
<div class="field-label">Intro Paragraph<\/div>
<textarea class="field-textarea" id="f-intro" rows="3" placeholder="Opening paragraph..." oninput="markDirty()"><\/textarea>
<\/div>
<div class="field-group">
<div class="field-label">Read Time<\/div>
<div class="readtime-row">
<input type="number" class="field-input" id="f-readtime" style="width:80px" min="1" max="60" value="5" oninput="markDirty()">
<span class="readtime-label">min read<\/span>
<\/div>
<\/div>
<div class="field-group">
<div class="field-label">Body<\/div>
<div id="quill-editor"><\/div>
<\/div>
<div class="field-group" style="margin-top:20px">
<div class="field-label">Frequently Asked Questions<\/div>
<div id="faq-list"><\/div>
<button class="btn-add-faq" onclick="addFaqItem()">+ Add FAQ<\/button>
<\/div>
<div class="field-group" style="margin-top:20px">
<div class="field-label">Keep Reading (Related Posts)<\/div>
<div id="related-list"><\/div>
<button class="btn-add-faq" onclick="addRelatedRow()">+ Add Related Post<\/button>
<\/div>
<div class="field-group">
<div class="field-label">CTA Type<\/div>
<select class="field-select" id="f-cta-type" onchange="markDirty()">
<option value="dl">Disneyland<\/option>
<option value="wdw">Walt Disney World<\/option>
<option value="both">Both Resorts<\/option>
<\/select>
<\/div>
<div class="field-group">
<div class="field-label">Status<\/div>
<div class="toggle-row">
<label class="toggle-switch">
<input type="checkbox" id="f-published" onchange="markDirty()">
<span class="toggle-slider"><\/span>
<\/label>
<span class="toggle-label" id="status-label">Draft<\/span>
<\/div>
<\/div>
<\/div>
<div class="editor-right">
<div class="field-group">
<div class="field-label">Hero Image<\/div>
<img id="hero-preview" class="hero-preview" src="" alt="" onerror="this.style.background='#eee'">
<div style="display:flex;gap:8px;margin-top:8px">
<button class="btn-choose-hero" style="flex:1" onclick="openImageManager('hero')">Choose from Library<\/button>
<button class="btn-choose-hero" style="flex:1" onclick="openHeroUpload()">Upload New<\/button>
<\/div>
<input type="file" id="hero-upload-input" accept="image/*" style="display:none">
<div id="hero-upload-progress" style="display:none;font-size:11px;color:#4A7A7C;margin-top:4px"><\/div>
<div style="margin-top:8px">
<div class="field-label" style="margin-bottom:4px">Hero Image URL<\/div>
<input type="text" class="field-input" id="f-hero-url" placeholder="https://..." oninput="onHeroUrlChange();markDirty()" style="font-size:11px">
<\/div>
<div style="margin-top:8px">
<div class="field-label" style="margin-bottom:4px">Alt Text<\/div>
<input type="text" class="field-input" id="f-hero-alt" placeholder="Describe the image" oninput="markDirty()">
<\/div>
<\/div>
<div class="field-group">
<div class="field-label">Focal Point<\/div>
<div class="focal-grid" id="focal-grid">
<button class="focal-dot" data-focal="top left" onclick="setFocal('top left')" title="top left"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="top center" onclick="setFocal('top center')" title="top center"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="top right" onclick="setFocal('top right')" title="top right"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="center left" onclick="setFocal('center left')" title="center left"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="center" onclick="setFocal('center')" title="center"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="center right" onclick="setFocal('center right')" title="center right"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="bottom left" onclick="setFocal('bottom left')" title="bottom left"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="bottom center" onclick="setFocal('bottom center')" title="bottom center"><span class="focal-dot-inner"><\/span><\/button><button class="focal-dot" data-focal="bottom right" onclick="setFocal('bottom right')" title="bottom right"><span class="focal-dot-inner"><\/span><\/button>
<\/div>
<\/div>
<div class="preview-section">
<div class="preview-label">Google Preview<\/div>
<div class="seo-card">
<div class="seo-title" id="seo-title">Post title<\/div>
<div class="seo-url" id="seo-url">themeparkcopilot.com/blog/<\/div>
<div class="seo-desc" id="seo-desc">Meta description will appear here...<\/div>
<\/div>
<\/div>
<div class="preview-section">
<div class="preview-label">Link Preview (iMessage / Social)<\/div>
<div class="og-card">
<img id="og-img" class="og-img" src="" alt="">
<div class="og-body">
<div class="og-site">themeparkcopilot.com<\/div>
<div class="og-title" id="og-title">Post title<\/div>
<div class="og-desc" id="og-desc">Meta description...<\/div>
<\/div>
<\/div>
<\/div>
<\/div>
<\/div>
<div class="action-bar">
<div class="action-bar-left">
<button class="btn-delete-post" id="btn-delete-post" onclick="confirmDelete()" style="display:none">Delete post<\/button>
<\/div>
<div class="action-bar-right">
<button class="btn-cancel-edit" onclick="cancelEdit()">Cancel<\/button>
<button class="btn-save-draft" id="btn-save-draft" onclick="savePost(false)">Save draft<\/button>
<button class="btn-preview-post" onclick="previewPost()">Preview<\/button>
<button class="btn-schedule" id="btn-schedule" onclick="openScheduleModal()" style="display:none">Schedule<\/button>
<button class="btn-publish" id="btn-publish" onclick="savePost(true)">Publish<\/button>
<\/div>
<\/div>
<\/div>


<!-- Images view -->
<div id="images-view" style="display:none">
<div class="posts-header">
<h1 class="posts-title">Image Library<\/h1>
<div style="display:flex;gap:8px;align-items:center">
<button id="btn-img-select" class="btn-save-draft" onclick="enterSelectMode()">Select<\/button>
<button id="btn-img-upload" class="btn-new-post" onclick="openImageManager('browse')">+ Add Photos<\/button>
<\/div>
<\/div>
<div id="images-inline-grid" style="margin-top:8px"><\/div>
<div id="multi-select-bar" style="display:none;position:sticky;bottom:0;background:white;border-top:1px solid rgba(7,30,37,0.08);padding:12px 0;margin-top:8px;align-items:center;justify-content:space-between;gap:12px">
<span id="select-count-label" style="font-size:12px;color:#4A7A7C;font-weight:600">0 selected<\/span>
<div style="display:flex;gap:8px">
<button class="btn-modal-cancel" onclick="exitSelectMode()">Cancel<\/button>
<button id="btn-delete-selected" class="btn-modal-confirm" disabled onclick="confirmMultiDelete()">Delete Selected (0)<\/button>
<\/div>
<\/div>
<div id="used-photos-section" style="display:none">
<div class="used-photos-divider"><\/div>
<div class="used-photos-heading">Used Photos<\/div>
<div class="used-photos-sub">Images currently used in published posts<\/div>
<div class="img-grid" id="used-photos-grid"><\/div>
<\/div>
<\/div>

<!-- Settings view -->
<div id="settings-view" style="display:none">
<h1 class="posts-title" style="margin-bottom:16px">Settings<\/h1>
<div class="settings-section">
<div class="settings-section-title">Read Time<\/div>
<div class="settings-section-desc">How read time is calculated for blog posts<\/div>
<div class="settings-field">
<div class="settings-label">Mode<\/div>
<div class="toggle-group">
<button class="toggle-opt active" id="rt-auto-btn" onclick="setReadTimeMode('auto')">Auto (calculated from word count)<\/button>
<button class="toggle-opt" id="rt-manual-btn" onclick="setReadTimeMode('manual')">Manual<\/button>
<\/div>
<\/div>
<\/div>
<div class="settings-section">
<div class="settings-section-title">Author Byline<\/div>
<div class="settings-section-desc">Appears on each blog post below the title<\/div>
<div class="settings-field">
<div class="settings-label">Byline text<\/div>
<input type="text" class="field-input" id="s-byline" value="By the Theme Park Co-Pilot Team" placeholder="Author byline...">
<\/div>
<\/div>
<div class="settings-section">
<div class="settings-section-title">Posts Per Page<\/div>
<div class="settings-section-desc">Number of posts shown on the blog index page<\/div>
<div class="settings-field">
<div class="settings-label">Count<\/div>
<input type="number" class="field-input" id="s-posts-per-page" value="30" min="5" max="100" style="width:100px">
<\/div>
<\/div>
<button class="btn-save-settings" onclick="saveSettings()">Save settings<\/button>
<span class="settings-saved" id="settings-saved">Saved &#10003;<\/span>
<\/div>

<!-- Batch Upload view -->
<div id="batch-view" style="display:none">
<div class="posts-header">
<h1 class="posts-title">Batch Upload<\/h1>
<\/div>
<div id="batch-drop-screen">
<div class="batch-drop-zone" id="batch-drop-zone" onclick="document.getElementById('batch-zip-input').click()">
<div class="batch-drop-icon">&#128230;<\/div>
<div style="font-weight:700;color:#071E25;margin-bottom:4px">Drop a ZIP file here</div>
<div style="font-size:12px">ZIP must contain posts.json and an images/ folder</div>
<\/div>
<input type="file" id="batch-zip-input" accept=".zip" style="display:none" onchange="handleBatchZip(this)">
<\/div>
<div id="batch-preview-screen" style="display:none">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
<div>
<div class="posts-title" style="font-size:16px" id="batch-preview-title">Preview<\/div>
<div style="font-size:12px;color:#8AACAE;margin-top:2px" id="batch-preview-subtitle"><\/div>
<\/div>
<button class="btn-modal-cancel" onclick="resetBatch()">&#8592; Back<\/button>
<\/div>
<div id="batch-preview-list"><\/div>
<div style="margin-top:16px">
<button class="btn-publish" id="btn-batch-upload" onclick="executeBatchUpload()" style="width:100%;padding:14px;font-size:14px">Upload &amp; Save as Drafts<\/button>
<\/div>
<\/div>
<div id="batch-progress-screen" style="display:none">
<div style="text-align:center;padding:40px 20px">
<div style="font-size:32px;margin-bottom:16px"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="" style="width:32px;height:32px;border-radius:8px;border:1.5px solid #ECA050;object-fit:cover"><\/div>
<div class="posts-title" style="font-size:16px;margin-bottom:8px" id="batch-progress-label">Uploading images...</div>
<div class="batch-progress-bar"><div class="batch-progress-fill" id="batch-progress-fill" style="width:0%"><\/div><\/div>
<div style="font-size:12px;color:#8AACAE;margin-top:8px" id="batch-progress-detail"><\/div>
<\/div>
<\/div>
<div id="batch-complete-screen" style="display:none">
<div style="text-align:center;padding:24px 20px 16px">
<div style="font-size:32px;margin-bottom:8px">&#10003;<\/div>
<div class="posts-title" style="font-size:16px;margin-bottom:4px" id="batch-complete-label"><\/div>
<div style="font-size:12px;color:#8AACAE;margin-bottom:20px" id="batch-complete-sub"><\/div>
<button class="btn-new-post" onclick="showView('drafts')" style="margin-bottom:12px">Go to Drafts<\/button>
<\/div>
<div id="batch-complete-results" style="padding:0 4px"><\/div>
<div style="margin-top:12px">
<button class="btn-modal-cancel" onclick="resetBatch()">Upload another ZIP<\/button>
<\/div>
<\/div>
<\/div>
<\/main>
<\/div>
<!-- Delete confirm modal -->
<div class="modal-overlay" id="delete-modal">
<div class="modal-box">
<div class="modal-title">Delete this post?<\/div>
<div class="modal-body">This action cannot be undone. The post will be removed from the blog immediately.<\/div>
<div class="modal-actions">
<button class="btn-modal-cancel" onclick="closeModal('delete-modal')">Cancel<\/button>
<button class="btn-modal-confirm" id="confirm-delete-btn" onclick="executeDelete()">Delete<\/button>
<\/div>
<\/div>
<\/div>

<!-- In-use image warning modal -->
<div class="modal-overlay" id="img-in-use-modal">
<div class="modal-box">
<div class="modal-title">Image In Use<\/div>
<div class="modal-body" id="img-in-use-body"><\/div>
<div class="modal-actions" id="img-in-use-single-actions" style="display:flex">
<button class="btn-modal-cancel" onclick="closeModal('img-in-use-modal')">Cancel<\/button>
<button class="btn-modal-confirm" onclick="deleteInUseAnyway()" style="background:#C82030">Delete Anyway<\/button>
<button class="btn-modal-stay" onclick="moveToUsedPhotos()">Move to Used Photos<\/button>
<\/div>
<div class="modal-actions" id="img-in-use-multi-actions" style="display:none">
<button class="btn-modal-cancel" onclick="closeModal('img-in-use-modal')">Cancel<\/button>
<button class="btn-modal-confirm" onclick="deleteMultiAnyway()" style="background:#C82030">Delete Anyway<\/button>
<button class="btn-modal-stay" onclick="moveMultiToUsedPhotos()">Move to Used Photos<\/button>
<\/div>
<\/div>
<\/div>

<!-- Unsaved changes modal -->
<div class="modal-overlay" id="unsaved-modal">
<div class="modal-box">
<div class="modal-title">Leave without saving?<\/div>
<div class="modal-body">Your changes will be lost.<\/div>
<div class="modal-actions">
<button class="btn-modal-leave" onclick="leaveWithoutSaving()">Leave without saving<\/button>
<button class="btn-modal-stay" onclick="closeModal('unsaved-modal')">Stay and keep editing<\/button>
<\/div>
<\/div>
<\/div>

<!-- Unsaved uploads modal (Fix 2) -->
<div class="modal-overlay" id="unsaved-uploads-modal">
<div class="modal-box">
<div class="modal-title">You have unsaved photos.<\/div>
<div class="modal-body">Leave without uploading?<\/div>
<div class="modal-actions">
<button class="btn-modal-stay" onclick="closeModal('unsaved-uploads-modal')">Stay<\/button>
<button class="btn-modal-leave" onclick="forceCloseImageManager()">Leave without uploading<\/button>
<\/div>
<\/div>
<\/div>

<!-- Schedule modal (Fix 4) -->
<div class="modal-overlay" id="schedule-modal">
<div class="schedule-modal-box">
<div class="modal-title" id="schedule-modal-title">Schedule Post<\/div>
<div style="margin-bottom:16px">
<div class="field-label" style="margin-bottom:6px">Date &amp; Time<\/div>
<input type="datetime-local" class="field-input" id="schedule-datetime" style="font-size:13px">
<div style="font-size:11px;color:#8AACAE;margin-top:4px">Times are in your local timezone<\/div>
<\/div>
<div class="modal-actions">
<button class="btn-modal-cancel" onclick="closeModal('schedule-modal')">Cancel<\/button>
<button class="btn-cancel-schedule" id="btn-cancel-schedule" onclick="cancelSchedule()" style="display:none">Remove schedule<\/button>
<button class="btn-schedule-confirm" onclick="confirmSchedule()">Schedule<\/button>
<\/div>
<\/div>
<\/div>

<!-- Image Manager Modal -->
<div class="img-modal-overlay" id="img-modal">
<div class="img-modal">
<div class="img-modal-header">
<div class="img-modal-title">Image Library<\/div>
<div class="img-modal-actions">
<button class="btn-upload-img" onclick="triggerUpload()">+ Add Photos<\/button>
<button class="btn-close-img" onclick="closeImageManager()">&times;<\/button>
<button class="btn-modal-cancel" id="img-picker-cancel" style="display:none;margin-right:8px" onclick="forceCloseImageManager()">Cancel<\/button>
<\/div>
<\/div>
<div class="img-modal-body">
<!-- FIX 2: Upload queue area -->
<div class="img-drop-zone" id="img-drop-zone">
Drag &amp; drop images here, or click to select<br><span style="font-size:11px;opacity:0.7">JPG, PNG, WebP, GIF &mdash; multiple files OK</span>
<\/div>
<div class="upload-warning" id="upload-warning"><\/div>
<div class="upload-queue" id="upload-queue" style="display:none">
<div class="field-label" style="margin-bottom:8px">Queue (<span id="queue-count">0<\/span> photo(s))<\/div>
<div class="upload-queue-grid" id="upload-queue-grid"><\/div>
<div class="upload-progress" id="upload-progress" style="display:none"><\/div>
<button class="btn-upload-queue" id="btn-upload-queue" disabled onclick="startUploadQueue()">Upload 0 photo(s)<\/button>
<\/div>
<input type="file" id="file-input" accept="image/*" multiple style="display:none" onchange="handleFileSelect(this)">
<div class="img-grid" id="img-grid"><\/div>
<div class="img-empty" id="img-empty" style="display:none">No images yet. Upload your first image above.<\/div>
<\/div>
<\/div>
<\/div>
<script src="/admin-client.js"><\/script>
<\/body>`;
