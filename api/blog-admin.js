export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(ADMIN_HTML);
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Theme Park Co-Pilot â Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link href="https://cdn.quilljs.com/1.3.7/quill.snow.css" rel="stylesheet">
<script src="https://cdn.quilljs.com/1.3.7/quill.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Outfit',sans-serif;background:#071E25;color:#071E25;min-height:100vh}
input,textarea,select,button{font-family:'Outfit',sans-serif}

/* LOGIN */
#login-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#071E25}
.login-card{background:white;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center}
.login-icon{width:48px;height:48px;border-radius:12px;border:2px solid #ECA050;margin:0 auto;overflow:hidden}
.login-icon img{width:100%;height:100%;object-fit:cover}
.login-label{font-size:10px;font-weight:700;letter-spacing:0.16em;color:#ECA050;text-transform:uppercase;margin-top:12px}
.login-wordmark{font-size:18px;font-weight:800;color:#071E25;margin-top:4px}
.login-input{width:100%;padding:11px 14px;border-radius:8px;border:1px solid rgba(7,30,37,0.15);font-size:14px;margin-top:24px;outline:none}
.login-input:focus{border-color:#C86030}
.login-btn{width:100%;background:#C86030;color:white;font-weight:700;border:none;border-radius:8px;padding:12px;margin-top:10px;font-size:14px;cursor:pointer}
.login-btn:hover{background:#B05528}
.login-btn:disabled{background:#ccc;cursor:not-allowed}
.login-error{color:#C82030;font-size:12px;margin-top:8px;min-height:18px}

/* APP SHELL */
#app{display:none;min-height:100vh;background:#F4F6F7}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:240px;background:#071E25;padding:20px 0;display:flex;flex-direction:column;z-index:100}
.sidebar-top{padding:0 20px;margin-bottom:32px;display:flex;align-items:center;gap:10px}
.sidebar-icon{width:32px;height:32px;border-radius:8px;border:1.5px solid #ECA050;overflow:hidden;flex-shrink:0}
.sidebar-icon img{width:100%;height:100%;object-fit:cover}
.sidebar-wordmark{font-size:13px;font-weight:800;color:white;line-height:1.2}
.sidebar-nav{padding:0 8px;flex:1}
.nav-item{width:100%;padding:10px 12px;border-radius:8px;display:flex;align-items:center;gap:10px;cursor:pointer;font-size:12px;font-weight:600;color:rgba(255,255,255,0.5);border:none;background:none;text-align:left;transition:all 0.15s}
.nav-item:hover{color:rgba(255,255,255,0.8)}
.nav-item.active{background:rgba(255,255,255,0.08);color:white}
.nav-item svg{width:16px;height:16px;flex-shrink:0}
.nav-badge{background:#ECA050;color:#071E25;font-size:9px;font-weight:800;border-radius:10px;padding:1px 6px;margin-left:auto}
.sidebar-bottom{padding:10px 20px}
.logout-btn{color:rgba(255,255,255,0.35);font-size:11px;cursor:pointer;border:none;background:none;font-family:'Outfit',sans-serif}
.logout-btn:hover{color:rgba(255,255,255,0.6)}

.main-content{margin-left:240px;padding:28px 32px;min-height:100vh}

/* POSTS LIST */
.posts-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.posts-title{font-size:18px;font-weight:800;color:#071E25}
.btn-new-post{background:#C86030;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-new-post:hover{background:#B05528}
.search-input{width:100%;padding:10px 14px;border:1px solid rgba(7,30,37,0.12);border-radius:8px;font-size:13px;outline:none;background:white}
.search-input:focus{border-color:#4A7A7C}
.posts-table{margin-top:16px}
.post-row{background:white;border-radius:10px;border:0.5px solid rgba(7,30,37,0.07);padding:12px 16px;display:flex;align-items:center;gap:12px;margin-bottom:6px;cursor:pointer;transition:box-shadow 0.15s}
.post-row:hover{box-shadow:0 2px 8px rgba(7,30,37,0.08)}
.post-thumb{width:60px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;background:#eee}
.post-title-cell{flex:1;font-size:13px;font-weight:600;color:#071E25;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.park-pill{font-size:7px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:20px;flex-shrink:0}
.park-dl{background:#E0F0EE;color:#0A4840}
.park-wdw{background:#FFF4E0;color:#8A5800}
.park-both{background:#EEF5F4;color:#4A7A7C}
.status-pill{font-size:7px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:20px;flex-shrink:0}
.status-published{background:#E0F5E8;color:#0F6830}
.status-draft{background:#F0F0F0;color:#666}
.post-date{font-size:11px;color:#8AACAE;flex-shrink:0;min-width:80px;text-align:right}
.post-actions{display:flex;gap:8px;flex-shrink:0}
.btn-edit{color:#4A7A7C;font-size:11px;background:none;border:none;cursor:pointer;padding:0;font-family:'Outfit',sans-serif;font-weight:600}
.btn-edit:hover{text-decoration:underline}
.btn-del{color:#C82030;font-size:11px;background:none;border:none;cursor:pointer;padding:0;font-family:'Outfit',sans-serif;font-weight:600}
.btn-del:hover{text-decoration:underline}

/* EDITOR */
#editor-view{display:none}
.editor-back{color:#4A7A7C;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;padding:0 0 16px 0;display:flex;align-items:center;gap:4px}
.editor-panels{display:flex;gap:24px;align-items:flex-start;padding-bottom:80px}
.editor-left{flex:0 0 60%;min-width:0}
.editor-right{flex:1;min-width:0}
.field-group{margin-bottom:16px}
.field-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#4A7A7C;margin-bottom:6px}
.field-input{width:100%;padding:10px 12px;border:1px solid rgba(7,30,37,0.12);border-radius:8px;font-size:14px;outline:none;color:#071E25}
.field-input:focus{border-color:#4A7A7C}
.field-input.title-input{font-size:16px;font-weight:700}
.field-textarea{width:100%;padding:10px 12px;border:1px solid rgba(7,30,37,0.12);border-radius:8px;font-size:13px;outline:none;color:#071E25;resize:vertical}
.field-textarea:focus{border-color:#4A7A7C}
.field-select{width:100%;padding:10px 12px;border:1px solid rgba(7,30,37,0.12);border-radius:8px;font-size:13px;outline:none;color:#071E25;background:white;cursor:pointer}
.slug-preview{font-size:10px;color:#8AACAE;margin-top:4px}
.meta-counter{font-size:10px;color:#8AACAE;text-align:right;margin-top:2px}
.meta-counter.warn{color:#ECA050}
.meta-counter.danger{color:#C82030}
.readtime-row{display:flex;align-items:center;gap:8px}
.readtime-label{font-size:13px;color:#8AACAE;white-space:nowrap}

/* Quill override */
.ql-container{border-radius:0 0 8px 8px!important;border-color:rgba(7,30,37,0.12)!important;min-height:400px}
.ql-toolbar{border-radius:8px 8px 0 0!important;border-color:rgba(7,30,37,0.12)!important;background:#fafafa}

/* FAQ */
.faq-item-editor{background:#fafafa;border:1px solid rgba(7,30,37,0.08);border-radius:8px;padding:12px;margin-bottom:8px;position:relative}
.faq-remove{position:absolute;top:8px;right:8px;background:none;border:none;color:#C82030;cursor:pointer;font-size:16px;line-height:1}
.btn-add-faq{background:none;border:1px solid #4A7A7C;color:#4A7A7C;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif;margin-top:4px}
.btn-add-faq:hover{background:#4A7A7C;color:white}

/* Related posts */
.related-row{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.related-row select{flex:1;padding:8px 10px;border:1px solid rgba(7,30,37,0.12);border-radius:8px;font-size:12px;outline:none}
.related-remove{background:none;border:none;color:#C82030;cursor:pointer;font-size:18px;line-height:1;padding:0 4px}

/* Status toggle */
.toggle-row{display:flex;align-items:center;gap:12px}
.toggle-switch{position:relative;width:44px;height:24px;cursor:pointer}
.toggle-switch input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:#ccc;border-radius:24px;transition:0.2s}
.toggle-slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:white;border-radius:50%;transition:0.2s}
.toggle-switch input:checked + .toggle-slider{background:#22A855}
.toggle-switch input:checked + .toggle-slider:before{transform:translateX(20px)}
.toggle-label{font-size:13px;font-weight:600;color:#071E25}

/* RIGHT PANEL */
.hero-preview{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px;background:#eee}
.btn-replace-hero{margin-top:8px;background:none;border:1px solid rgba(7,30,37,0.15);color:#4A7A7C;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif;width:100%}
.btn-replace-hero:hover{background:#4A7A7C;color:white}

/* Focal point */
.focal-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;width:80px;height:60px;margin-top:8px}
.focal-dot{width:100%;height:100%;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;background:none}
.focal-dot-inner{width:10px;height:10px;border-radius:50%;border:1.5px solid #4A7A7C;transition:all 0.15s}
.focal-dot.selected .focal-dot-inner{background:#ECA050;border-color:#ECA050}

/* SEO preview */
.preview-section{margin-top:16px}
.preview-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#4A7A7C;margin-bottom:6px}
.seo-card{background:white;border-radius:8px;padding:12px;border:1px solid rgba(7,30,37,0.07)}
.seo-title{color:#1a0dab;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.seo-url{color:#006621;font-size:12px;margin-top:2px}
.seo-desc{color:#545454;font-size:13px;margin-top:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.og-card{background:white;border-radius:8px;overflow:hidden;border:1px solid rgba(7,30,37,0.07)}
.og-img{width:100%;height:120px;object-fit:cover;background:#eee;display:block}
.og-body{padding:8px 10px}
.og-site{font-size:10px;color:#8AACAE;text-transform:uppercase;letter-spacing:0.06em}
.og-title{font-size:13px;font-weight:600;color:#071E25;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.og-desc{font-size:11px;color:#8AACAE;margin-top:2px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}

/* ACTION BAR */
.action-bar{position:fixed;bottom:0;left:240px;right:0;background:white;border-top:0.5px solid rgba(7,30,37,0.08);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;z-index:50}
.action-bar-left{display:flex;gap:16px;align-items:center}
.btn-delete-post{color:#C82030;font-size:12px;background:none;border:none;cursor:pointer;font-family:'Outfit',sans-serif;font-weight:600}
.btn-delete-post:hover{text-decoration:underline}
.btn-save-draft{background:none;border:1px solid rgba(7,30,37,0.15);color:#4A7A7C;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-save-draft:hover{background:#f0f4f4}
.action-bar-right{display:flex;gap:8px;align-items:center}
.btn-preview-post{background:none;border:1px solid rgba(7,30,37,0.15);color:#4A7A7C;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-preview-post:hover{background:#f0f4f4}
.btn-publish{background:#C86030;color:white;border:none;border-radius:8px;padding:10px 20px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-publish:hover{background:#B05528}
.btn-loading{opacity:0.6;cursor:not-allowed!important}

/* TOAST */
.toast{position:fixed;bottom:80px;right:20px;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;color:white;z-index:9999;animation:slideIn 0.2s ease;box-shadow:0 4px 12px rgba(0,0,0,0.15)}
.toast-success{background:#22A855}
.toast-error{background:#C82030}
@keyframes slideIn{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}

/* MODAL */
.modal-overlay{position:fixed;inset:0;background:rgba(7,30,37,0.7);display:none;align-items:center;justify-content:center;z-index:200}
.modal-overlay.active{display:flex}
.modal-box{background:white;border-radius:16px;padding:28px;max-width:400px;width:90%}
.modal-title{font-size:16px;font-weight:800;color:#071E25;margin-bottom:8px}
.modal-body{font-size:13px;color:#4A7A7C;margin-bottom:20px}
.modal-actions{display:flex;gap:10px;justify-content:flex-end}
.btn-modal-cancel{background:none;border:1px solid rgba(7,30,37,0.15);color:#4A7A7C;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-modal-confirm{background:#C82030;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}

/* IMAGE MANAGER */
.img-modal-overlay{position:fixed;inset:0;background:rgba(7,30,37,0.7);display:none;align-items:flex-start;justify-content:center;z-index:300;padding:40px 20px;overflow-y:auto}
.img-modal-overlay.active{display:flex}
.img-modal{background:white;border-radius:16px;width:100%;max-width:800px;max-height:80vh;display:flex;flex-direction:column}
.img-modal-header{padding:16px 20px;border-bottom:1px solid rgba(7,30,37,0.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.img-modal-title{font-size:16px;font-weight:800;color:#071E25}
.img-modal-actions{display:flex;gap:8px;align-items:center}
.btn-upload-img{background:#C86030;color:white;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-close-img{background:none;border:none;font-size:20px;color:#8AACAE;cursor:pointer;line-height:1;padding:0 4px}
.btn-close-img:hover{color:#071E25}
.img-modal-body{padding:16px;overflow-y:auto;flex:1}
.img-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.img-cell{cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid transparent;transition:border-color 0.15s}
.img-cell:hover{border-color:#4A7A7C}
.img-cell img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#eee}
.img-cell-name{font-size:10px;color:#8AACAE;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.upload-progress{background:#E0F0EE;border-radius:8px;padding:8px 12px;font-size:12px;color:#0A4840;margin-bottom:12px;display:none}
.img-empty{text-align:center;color:#8AACAE;font-size:13px;padding:40px}

/* COMING SOON */
.coming-soon{display:flex;align-items:center;justify-content:center;height:200px;color:#8AACAE;font-size:14px;font-weight:600}

/* RESPONSIVE */
@media(max-width:768px){
  .sidebar{transform:translateX(-240px);transition:transform 0.2s}
  .sidebar.open{transform:translateX(0)}
  .main-content{margin-left:0;padding:16px}
  .editor-panels{flex-direction:column}
  .editor-left,.editor-right{flex:none;width:100%}
  .action-bar{left:0}
  .mobile-menu-btn{display:flex!important}
  .img-grid{grid-template-columns:repeat(2,1fr)}
}
.mobile-menu-btn{display:none;position:fixed;top:12px;left:12px;z-index:150;background:#071E25;border:none;border-radius:8px;padding:8px;cursor:pointer}
.mobile-menu-btn svg{width:20px;height:20px;color:white;stroke:currentColor}
</style>
</head>
<body>
<!-- MOBILE MENU BUTTON -->
<button class="mobile-menu-btn" onclick="document.querySelector('.sidebar').classList.toggle('open')" aria-label="Menu">
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/></svg>
</button>

<!-- LOGIN SCREEN -->
<div id="login-screen">
  <div class="login-card">
    <div class="login-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt=""></div>
    <div class="login-label">Admin</div>
    <div class="login-wordmark">Theme Park CoâPilot</div>
    <input type="password" class="login-input" id="pw-input" placeholder="Admin password" autocomplete="current-password">
    <button class="login-btn" id="login-btn" onclick="doLogin()">Enter</button>
    <div class="login-error" id="login-error"></div>
  </div>
</div>

<!-- MAIN APP -->
<div id="app">
  <!-- Sidebar -->
  <nav class="sidebar" id="sidebar">
    <div class="sidebar-top">
      <div class="sidebar-icon"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt=""></div>
      <div class="sidebar-wordmark">Theme Park<br>CoâPilot</div>
    </div>
    <div class="sidebar-nav">
      <button class="nav-item active" id="nav-posts" onclick="showView('posts')">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"/></svg>
        Posts <span class="nav-badge" id="posts-badge">0</span>
      </button>
      <button class="nav-item" id="nav-new" onclick="openNewPost()">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"/></svg>
        New Post
      </button>
      <button class="nav-item" id="nav-images" onclick="showView('images')">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/></svg>
        Images
      </button>
      <button class="nav-item" id="nav-settings" onclick="showView('settings')">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>
        Settings
      </button>
    </div>
    <div class="sidebar-bottom">
      <button class="logout-btn" onclick="doLogout()">Sign out</button>
    </div>
  </nav>

  <!-- Main area -->
  <main class="main-content">
    <!-- Posts list view -->
    <div id="posts-view">
      <div class="posts-header">
        <h1 class="posts-title">Posts</h1>
        <button class="btn-new-post" onclick="openNewPost()">+ New Post</button>
      </div>
      <input type="text" class="search-input" placeholder="Search posts..." oninput="filterPosts(this.value)">
      <div class="posts-table" id="posts-table"></div>
    </div>

    <!-- Editor view -->
    <div id="editor-view">
      <button class="editor-back" onclick="showView('posts')">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>
        Posts
      </button>
      <div class="editor-panels">
        <div class="editor-left">
          <!-- Title -->
          <div class="field-group">
            <div class="field-label">Title</div>
            <input type="text" class="field-input title-input" id="f-title" placeholder="Post title" oninput="onTitleChange()">
          </div>
          <!-- Slug -->
          <div class="field-group">
            <div class="field-label">Slug</div>
            <input type="text" class="field-input" id="f-slug" placeholder="post-slug" oninput="updatePreviews()">
            <div class="slug-preview" id="slug-preview">themeparkcopilot.com/blog/</div>
          </div>
          <!-- Park -->
          <div class="field-group">
            <div class="field-label">Park</div>
            <select class="field-select" id="f-park">
              <option value="dl">Disneyland</option>
              <option value="wdw">Walt Disney World</option>
              <option value="both">Both Resorts</option>
            </select>
          </div>
          <!-- Meta -->
          <div class="field-group">
            <div class="field-label">Meta Description</div>
            <textarea class="field-textarea" id="f-meta" rows="3" placeholder="Meta description..." oninput="onMetaChange()"></textarea>
            <div class="meta-counter" id="meta-counter">0 / 160</div>
          </div>
          <!-- Intro -->
          <div class="field-group">
            <div class="field-label">Intro Paragraph</div>
            <textarea class="field-textarea" id="f-intro" rows="3" placeholder="Opening paragraph..."></textarea>
          </div>
          <!-- Read time -->
          <div class="field-group">
            <div class="field-label">Read Time</div>
            <div class="readtime-row">
              <input type="number" class="field-input" id="f-readtime" style="width:80px" min="1" max="60" value="5">
              <span class="readtime-label">min read</span>
            </div>
          </div>
          <!-- Body -->
          <div class="field-group">
            <div class="field-label">Body</div>
            <div id="quill-editor"></div>
          </div>
          <!-- FAQs -->
          <div class="field-group" style="margin-top:20px">
            <div class="field-label">Frequently Asked Questions</div>
            <div id="faq-list"></div>
            <button class="btn-add-faq" onclick="addFaqItem()">+ Add FAQ</button>
          </div>
          <!-- Related -->
          <div class="field-group" style="margin-top:20px">
            <div class="field-label">Keep Reading (Related Posts)</div>
            <div id="related-list"></div>
            <button class="btn-add-faq" onclick="addRelatedRow()">+ Add Related Post</button>
          </div>
          <!-- CTA type -->
          <div class="field-group">
            <div class="field-label">CTA Type</div>
            <select class="field-select" id="f-cta-type">
              <option value="dl">Disneyland</option>
              <option value="wdw">Walt Disney World</option>
              <option value="both">Both Resorts</option>
            </select>
          </div>
          <!-- Status -->
          <div class="field-group">
            <div class="field-label">Status</div>
            <div class="toggle-row">
              <label class="toggle-switch">
                <input type="checkbox" id="f-published">
                <span class="toggle-slider"></span>
              </label>
              <span class="toggle-label" id="status-label">Draft</span>
            </div>
          </div>
        </div>
        <div class="editor-right">
          <!-- Hero image -->
          <div class="field-group">
            <div class="field-label">Hero Image</div>
            <img id="hero-preview" class="hero-preview" src="" alt="" onerror="this.style.background='#eee'">
            <button class="btn-replace-hero" onclick="openImageManager('hero')">Replace image</button>
            <div style="margin-top:8px">
              <div class="field-label" style="margin-bottom:4px">Alt Text</div>
              <input type="text" class="field-input" id="f-hero-alt" placeholder="Describe the image">
            </div>
          </div>
          <!-- Focal point -->
          <div class="field-group">
            <div class="field-label">Focal Point</div>
            <div class="focal-grid" id="focal-grid">
              <button class="focal-dot" data-focal="top left" onclick="setFocal('top left')" title="top left"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="top center" onclick="setFocal('top center')" title="top center"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="top right" onclick="setFocal('top right')" title="top right"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="center left" onclick="setFocal('center left')" title="center left"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="center" onclick="setFocal('center')" title="center"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="center right" onclick="setFocal('center right')" title="center right"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="bottom left" onclick="setFocal('bottom left')" title="bottom left"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="bottom center" onclick="setFocal('bottom center')" title="bottom center"><span class="focal-dot-inner"></span></button><button class="focal-dot" data-focal="bottom right" onclick="setFocal('bottom right')" title="bottom right"><span class="focal-dot-inner"></span></button>
            </div>
          </div>
          <!-- SEO preview -->
          <div class="preview-section">
            <div class="preview-label">Google Preview</div>
            <div class="seo-card">
              <div class="seo-title" id="seo-title">Post title</div>
              <div class="seo-url" id="seo-url">themeparkcopilot.com/blog/</div>
              <div class="seo-desc" id="seo-desc">Meta description will appear here...</div>
            </div>
          </div>
          <!-- OG preview -->
          <div class="preview-section">
            <div class="preview-label">Link Preview (iMessage / Social)</div>
            <div class="og-card">
              <img id="og-img" class="og-img" src="" alt="">
              <div class="og-body">
                <div class="og-site">themeparkcopilot.com</div>
                <div class="og-title" id="og-title">Post title</div>
                <div class="og-desc" id="og-desc">Meta description...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- Sticky action bar -->
      <div class="action-bar">
        <div class="action-bar-left">
          <button class="btn-delete-post" id="btn-delete-post" onclick="confirmDelete()" style="display:none">Delete post</button>
          <button class="btn-save-draft" id="btn-save-draft" onclick="savePost(false)">Save draft</button>
        </div>
        <div class="action-bar-right">
          <button class="btn-preview-post" onclick="previewPost()">Preview</button>
          <button class="btn-publish" id="btn-publish" onclick="savePost(true)">Publish</button>
        </div>
      </div>
    </div>

    <!-- Images view -->
    <div id="images-view" style="display:none">
      <div class="posts-header">
        <h1 class="posts-title">Images</h1>
        <button class="btn-new-post" onclick="openImageManager('browse')">Upload Image</button>
      </div>
      <div id="images-inline-grid" style="margin-top:8px"></div>
    </div>

    <!-- Settings view -->
    <div id="settings-view" style="display:none">
      <h1 class="posts-title" style="margin-bottom:16px">Settings</h1>
      <div class="coming-soon">Coming soon</div>
    </div>
  </main>
</div>

<!-- Delete confirm modal -->
<div class="modal-overlay" id="delete-modal">
  <div class="modal-box">
    <div class="modal-title">Delete this post?</div>
    <div class="modal-body">This action cannot be undone. The post will be removed from the blog immediately.</div>
    <div class="modal-actions">
      <button class="btn-modal-cancel" onclick="closeModal('delete-modal')">Cancel</button>
      <button class="btn-modal-confirm" id="confirm-delete-btn" onclick="executeDelete()">Delete</button>
    </div>
  </div>
</div>

<!-- Image Manager Modal -->
<div class="img-modal-overlay" id="img-modal">
  <div class="img-modal">
    <div class="img-modal-header">
      <div class="img-modal-title">Image Library</div>
      <div class="img-modal-actions">
        <button class="btn-upload-img" onclick="triggerUpload()">Upload</button>
        <button class="btn-close-img" onclick="closeImageManager()">Ã</button>
      </div>
    </div>
    <div class="img-modal-body">
      <div class="upload-progress" id="upload-progress">Uploading...</div>
      <input type="file" id="file-input" accept="image/*" style="display:none" onchange="handleFileUpload(this)">
      <div class="img-grid" id="img-grid"></div>
      <div class="img-empty" id="img-empty" style="display:none">No images yet. Upload your first image above.</div>
    </div>
  </div>
</div>
<script>
// ============================================================
// STATE
// ============================================================
const API_BASE = '';
let token = sessionStorage.getItem('tpcp_admin_token') || '';
let allPosts = [];
let currentPost = null;
let imgManagerContext = 'hero'; // 'hero' | 'browse' | 'quill'
let quill = null;
let loginFailures = 0;
let loginLocked = false;

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
      token = pw;
      sessionStorage.setItem('tpcp_admin_token', token);
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
      } else {
        btn.disabled = false;
      }
    }
  }).catch(() => {
    document.getElementById('login-error').textContent = 'Network error. Try again.';
    btn.textContent = 'Enter';
    btn.disabled = false;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (token) {
    showApp();
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
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  initQuill();
  loadPosts();
}

function initQuill() {
  if (quill) return;
  quill = new Quill('#quill-editor', {
    theme: 'snow',
    modules: {
      toolbar: {
        container: [
          ['bold', 'italic'],
          [{ header: 2 }, { header: 3 }],
          [{ list: 'bullet' }, { list: 'ordered' }],
          ['link', 'image']
        ],
        handlers: {
          image: function() { openImageManager('quill'); }
        }
      }
    }
  });
}

// Toggle status label
document.getElementById && document.addEventListener('change', e => {
  if (e.target && e.target.id === 'f-published') {
    document.getElementById('status-label').textContent = e.target.checked ? 'Published' : 'Draft';
  }
});

// ============================================================
// NAV / VIEWS
// ============================================================
function showView(v) {
  ['posts','editor','images','settings'].forEach(id => {
    const el = document.getElementById(id + '-view');
    if (el) el.style.display = 'none';
  });
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  if (v === 'posts') {
    document.getElementById('posts-view').style.display = 'block';
    document.getElementById('nav-posts').classList.add('active');
  } else if (v === 'editor') {
    document.getElementById('editor-view').style.display = 'block';
    document.getElementById('nav-new').classList.add('active');
  } else if (v === 'images') {
    document.getElementById('images-view').style.display = 'block';
    document.getElementById('nav-images').classList.add('active');
    loadImagesInline();
  } else if (v === 'settings') {
    document.getElementById('settings-view').style.display = 'block';
    document.getElementById('nav-settings').classList.add('active');
  }
}

// ============================================================
// POSTS LIST
// ============================================================
async function loadPosts() {
  try {
    const r = await fetch(API_BASE + '/api/blog-index');
    allPosts = await r.json();
    if (!Array.isArray(allPosts)) allPosts = [];
    renderPostList(allPosts);
    document.getElementById('posts-badge').textContent = allPosts.length;
  } catch(e) {
    showToast('Failed to load posts', 'error');
  }
}

function renderPostList(posts) {
  const table = document.getElementById('posts-table');
  if (!posts.length) {
    table.innerHTML = '<div style="text-align:center;color:#8AACAE;padding:40px;font-size:14px">No posts yet.</div>';
    return;
  }
  table.innerHTML = posts.map(p => {
    const parkCls = p.park === 'dl' ? 'park-dl' : p.park === 'wdw' ? 'park-wdw' : 'park-both';
    const parkLabel = p.park === 'dl' ? 'Disneyland' : p.park === 'wdw' ? 'WDW' : 'Both';
    const statusCls = p.published ? 'status-published' : 'status-draft';
    const statusLabel = p.published ? 'Published' : 'Draft';
    const date = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
    return \`<div class="post-row" onclick="openPost('\${p.slug}')">
      <img class="post-thumb" src="\${p.heroImage||''}" alt="" loading="lazy" onerror="this.src=''">
      <span class="post-title-cell">\${escHtml(p.title||'Untitled')}</span>
      <span class="park-pill \${parkCls}">\${parkLabel}</span>
      <span class="status-pill \${statusCls}">\${statusLabel}</span>
      <span class="post-date">\${date}</span>
      <div class="post-actions" onclick="event.stopPropagation()">
        <button class="btn-edit" onclick="openPost('\${p.slug}')">Edit</button>
        <button class="btn-del" onclick="quickDelete('\${p.slug}')">Delete</button>
      </div>
    </div>\`;
  }).join('');
}

function filterPosts(q) {
  if (!q) { renderPostList(allPosts); return; }
  const lq = q.toLowerCase();
  renderPostList(allPosts.filter(p => (p.title||'').toLowerCase().includes(lq) || (p.slug||'').toLowerCase().includes(lq)));
}

// ============================================================
// EDITOR
// ============================================================
function openNewPost() {
  currentPost = null;
  clearEditor();
  document.getElementById('btn-delete-post').style.display = 'none';
  showView('editor');
}

async function openPost(slug) {
  try {
    const r = await fetch(API_BASE + '/api/blog-post?slug=' + encodeURIComponent(slug));
    if (!r.ok) { showToast('Could not load post', 'error'); return; }
    const post = await r.json();
    currentPost = post;
    populateEditor(post);
    document.getElementById('btn-delete-post').style.display = 'block';
    showView('editor');
  } catch(e) {
    showToast('Failed to load post', 'error');
  }
}

function clearEditor() {
  document.getElementById('f-title').value = '';
  document.getElementById('f-slug').value = '';
  document.getElementById('f-park').value = 'dl';
  document.getElementById('f-meta').value = '';
  document.getElementById('f-intro').value = '';
  document.getElementById('f-readtime').value = '5';
  document.getElementById('f-hero-alt').value = '';
  document.getElementById('f-published').checked = false;
  document.getElementById('status-label').textContent = 'Draft';
  document.getElementById('f-cta-type').value = 'dl';
  document.getElementById('hero-preview').src = '';
  document.getElementById('faq-list').innerHTML = '';
  document.getElementById('related-list').innerHTML = '';
  if (quill) quill.setContents([]);
  setFocal('center');
  updatePreviews();
}

function populateEditor(post) {
  document.getElementById('f-title').value = post.title || '';
  document.getElementById('f-slug').value = post.slug || '';
  document.getElementById('f-park').value = post.park || 'dl';
  document.getElementById('f-meta').value = post.metaDescription || '';
  document.getElementById('f-intro').value = post.intro || '';
  document.getElementById('f-readtime').value = post.readTime || '5';
  document.getElementById('f-hero-alt').value = post.heroAlt || '';
  document.getElementById('f-published').checked = !!post.published;
  document.getElementById('status-label').textContent = post.published ? 'Published' : 'Draft';
  document.getElementById('f-cta-type').value = (post.cta && post.cta.type) || 'dl';
  document.getElementById('hero-preview').src = post.heroImage || '';
  document.getElementById('hero-preview').style.objectPosition = post.heroFocal || 'center';

  // Focal point
  const focal = post.heroFocal || 'center';
  document.querySelectorAll('.focal-dot').forEach(d => {
    d.classList.toggle('selected', d.dataset.focal === focal);
  });

  // Body
  if (quill) {
    if (post.body) {
      quill.root.innerHTML = post.body;
    } else {
      quill.setContents([]);
    }
  }

  // FAQs
  const faqList = document.getElementById('faq-list');
  faqList.innerHTML = '';
  (post.faqs || []).forEach(faq => addFaqItem(faq.q, faq.a));

  // Related
  const relList = document.getElementById('related-list');
  relList.innerHTML = '';
  (post.related || []).forEach(rel => addRelatedRow(rel.slug));

  onMetaChange();
  updatePreviews();
}

function onTitleChange() {
  const title = document.getElementById('f-title').value;
  const slugEl = document.getElementById('f-slug');
  // Only auto-gen slug if new post or slug is currently empty
  if (!currentPost || !slugEl.value) {
    slugEl.value = slugify(title);
  }
  updatePreviews();
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9\\s-]/g,'').replace(/\\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
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
  const heroSrc = document.getElementById('hero-preview').src;

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
  div.innerHTML = \`<button class="faq-remove" onclick="this.parentElement.remove()">\\u00d7</button>
    <div class="field-label" style="margin-bottom:6px">Question</div>
    <input type="text" class="field-input" placeholder="Question" value="\${escHtml(q||'')}">
    <div class="field-label" style="margin-top:8px;margin-bottom:6px">Answer</div>
    <textarea class="field-textarea" rows="3" placeholder="Answer">\${escHtml(a||'')}</textarea>\`;
  list.appendChild(div);
}

// ============================================================
// RELATED
// ============================================================
function addRelatedRow(selectedSlug) {
  const list = document.getElementById('related-list');
  const div = document.createElement('div');
  div.className = 'related-row';
  const opts = allPosts.map(p => \`<option value="\${p.slug}" \${p.slug===selectedSlug?'selected':''}>\${escHtml(p.title||p.slug)} [\${p.park||''}]</option>\`).join('');
  div.innerHTML = \`<select>\${opts}</select><button class="related-remove" onclick="this.parentElement.remove()">\\u00d7</button>\`;
  list.appendChild(div);
}

// ============================================================
// FOCAL POINT
// ============================================================
function setFocal(val) {
  document.querySelectorAll('.focal-dot').forEach(d => {
    d.classList.toggle('selected', d.dataset.focal === val);
  });
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
    if (inputs[0] && inputs[1]) {
      faqs.push({ q: inputs[0].value.trim(), a: inputs[1].value.trim() });
    }
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

  const CTA_TEXT = {
    dl: { text: 'Get the Theme Park Co-Pilot app and see real Disneyland wait times, crowd forecasts, and personalized plans.', buttonText: 'Try free for 7 days â', buttonUrl: 'https://themeparkcopilot.com' },
    wdw: { text: 'Get the Theme Park Co-Pilot app and see real Walt Disney World wait times, crowd forecasts, and personalized plans.', buttonText: 'Try free for 7 days â', buttonUrl: 'https://themeparkcopilot.com' },
    both: { text: 'Get the Theme Park Co-Pilot app and see real Disney park wait times, crowd forecasts, and personalized plans for every resort.', buttonText: 'Try free for 7 days â', buttonUrl: 'https://themeparkcopilot.com' }
  };

  const parkLabels = { dl: 'Disneyland', wdw: 'Walt Disney World', both: 'Both Resorts' };
  const category = parkLabels[park] + ' Â· Guide';

  return {
    slug,
    title: document.getElementById('f-title').value.trim(),
    metaDescription: document.getElementById('f-meta').value.trim(),
    park,
    category,
    tagLabel: parkLabels[park],
    heroImage: document.getElementById('hero-preview').src || '',
    heroAlt: document.getElementById('f-hero-alt').value.trim(),
    heroFocal: document.getElementById('hero-preview').dataset.focal || 'center',
    intro: document.getElementById('f-intro').value.trim(),
    readTime: document.getElementById('f-readtime').value || '5',
    publishedAt: existingPublishedAt || now,
    updatedAt: now,
    published: isPublished,
    body: quill ? quill.root.innerHTML : '',
    faqs,
    related,
    cta: { type: ctaType, ...CTA_TEXT[ctaType] }
  };
}

async function savePost(publish) {
  const btn = publish ? document.getElementById('btn-publish') : document.getElementById('btn-save-draft');
  const origText = btn.textContent;
  btn.textContent = publish ? 'Publishing...' : 'Saving...';
  btn.classList.add('btn-loading');
  btn.disabled = true;

  const post = collectPost(publish);
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
      document.getElementById('f-published').checked = post.published;
      document.getElementById('status-label').textContent = post.published ? 'Published' : 'Draft';
      document.getElementById('btn-delete-post').style.display = 'block';
      showToast(publish ? 'Published â' : 'Saved â', 'success');
      await loadPosts();
    } else {
      showToast('Save failed â try again', 'error');
    }
  } catch(e) {
    showToast('Save failed â try again', 'error');
  } finally {
    btn.textContent = origText;
    btn.classList.remove('btn-loading');
    btn.disabled = false;
  }
}

function previewPost() {
  const slug = document.getElementById('f-slug').value.trim();
  if (slug) window.open('/blog/' + slug, '_blank');
}

// ============================================================
// DELETE
// ============================================================
function quickDelete(slug) {
  currentPost = { slug };
  confirmDelete();
}

function confirmDelete() {
  document.getElementById('delete-modal').classList.add('active');
}

async function executeDelete() {
  const slug = currentPost ? currentPost.slug : null;
  if (!slug) { closeModal('delete-modal'); return; }
  const btn = document.getElementById('confirm-delete-btn');
  btn.textContent = 'Deleting...';
  btn.disabled = true;
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
      currentPost = null;
      showView('posts');
      await loadPosts();
    } else {
      showToast('Delete failed', 'error');
    }
  } catch(e) {
    showToast('Delete failed', 'error');
  } finally {
    btn.textContent = 'Delete';
    btn.disabled = false;
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// ============================================================
// IMAGE MANAGER
// ============================================================
function openImageManager(ctx) {
  imgManagerContext = ctx;
  document.getElementById('img-modal').classList.add('active');
  loadImages();
}

function closeImageManager() {
  document.getElementById('img-modal').classList.remove('active');
}

async function loadImages() {
  const grid = document.getElementById('img-grid');
  const empty = document.getElementById('img-empty');
  grid.innerHTML = '<div style="color:#8AACAE;font-size:13px;padding:20px">Loading...</div>';
  empty.style.display = 'none';
  try {
    const r = await fetch(API_BASE + '/api/blog-images', { headers: { 'x-admin-key': token } });
    const images = await r.json();
    if (!images.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    grid.innerHTML = images.map(img => \`<div class="img-cell" onclick="selectImage('\${escAttr(img.url)}')">
      <img src="\${escAttr(img.url)}" alt="\${escAttr(img.filename)}" loading="lazy">
      <div class="img-cell-name">\${escHtml(img.filename)}</div>
    </div>\`).join('');
  } catch(e) {
    grid.innerHTML = '<div style="color:#C82030;font-size:13px;padding:20px">Failed to load images.</div>';
  }
}

async function loadImagesInline() {
  const grid = document.getElementById('images-inline-grid');
  grid.innerHTML = '<div style="color:#8AACAE;font-size:13px">Loading...</div>';
  try {
    const r = await fetch(API_BASE + '/api/blog-images', { headers: { 'x-admin-key': token } });
    const images = await r.json();
    if (!images.length) { grid.innerHTML = '<div class="coming-soon">No images yet. Upload from the Image Manager.</div>'; return; }
    grid.innerHTML = '<div class="img-grid">' + images.map(img => \`<div class="img-cell" onclick="openImageManager('browse')">
      <img src="\${escAttr(img.url)}" alt="\${escAttr(img.filename)}" loading="lazy">
      <div class="img-cell-name">\${escHtml(img.filename)}</div>
    </div>\`).join('') + '</div>';
  } catch(e) {
    grid.innerHTML = '<div style="color:#C82030;font-size:13px">Failed to load images.</div>';
  }
}

function selectImage(url) {
  if (imgManagerContext === 'hero') {
    document.getElementById('hero-preview').src = url;
    document.getElementById('og-img').src = url;
  } else if (imgManagerContext === 'quill' && quill) {
    const range = quill.getSelection(true);
    quill.insertEmbed(range.index, 'image', url);
  }
  closeImageManager();
}

function triggerUpload() {
  document.getElementById('file-input').click();
}

async function handleFileUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const progress = document.getElementById('upload-progress');
  progress.textContent = 'Uploading ' + file.name + '...';
  progress.style.display = 'block';
  try {
    const r = await fetch(API_BASE + '/api/blog-upload-image', {
      method: 'POST',
      headers: { 'x-admin-key': token, 'x-filename': file.name, 'Content-Type': file.type },
      body: file
    });
    const data = await r.json();
    if (r.ok && data.url) {
      progress.textContent = 'Upload complete!';
      setTimeout(() => { progress.style.display = 'none'; }, 2000);
      loadImages();
    } else {
      progress.textContent = 'Upload failed: ' + (data.error || 'Unknown error');
      progress.style.color = '#C82030';
    }
  } catch(e) {
    progress.textContent = 'Upload failed.';
    progress.style.color = '#C82030';
  }
  input.value = '';
}

// ============================================================
// UTILS
// ============================================================
function showToast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Toggle status on checkbox change
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'f-published') {
    document.getElementById('status-label').textContent = e.target.checked ? 'Published' : 'Draft';
  }
});
</script>
</body>`;
