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
.sidebar{position:fixed;left:0;top:0;bottom:0;width:240px;background:#071E25;padding:20px 0;display:flex;flex-direction:column;z-index:100;overflow-y:auto}
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
/* DRAFTS SECTION */
.drafts-section{margin:8px 8px 4px;padding:8px 0}
.drafts-label{font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.3);padding:0 12px;margin-bottom:4px}
.draft-item{width:100%;padding:7px 12px;border-radius:8px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;cursor:pointer;font-size:11px;font-weight:500;color:rgba(255,255,255,0.6);border:none;background:none;text-align:left;transition:all 0.15s}
.draft-item:hover{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.9)}
.draft-item-row{display:flex;align-items:center;gap:8px;width:100%}
.draft-item-title{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.draft-pill{background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.5);font-size:8px;font-weight:700;text-transform:uppercase;border-radius:6px;padding:2px 6px;flex-shrink:0}
.draft-pill-scheduled{background:#D97706;color:#fff;font-size:8px;font-weight:700;text-transform:uppercase;border-radius:6px;padding:2px 6px;flex-shrink:0}
.draft-scheduled-date{font-size:9px;color:#ECA050;padding-left:2px;margin-top:1px}
.drafts-divider{height:1px;background:rgba(255,255,255,0.07);margin:8px 12px}/* POSTS LIST */
.posts-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.posts-title{font-size:18px;font-weight:800;color:#071E25}
.btn-new-post{background:#C86030;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-new-post:hover{background:#B05528}
.search-input{width:100%;padding:10px 14px;border:1px solid rgba(7,30,37,0.12);border-radius:8px;font-size:13px;outline:none;background:white}
.search-input:focus{border-color:#4A7A7C}
.posts-table{margin-top:16px;display:flex;flex-direction:column;gap:8px}
.post-row{background:white;border-radius:10px;border:0.5px solid rgba(7,30,37,0.07);padding:12px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:box-shadow 0.15s}
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
.status-scheduled{background:#FEF3C7;color:#D97706}
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
.ql-undo,.ql-redo{cursor:pointer}
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
.hero-field-row{display:flex;align-items:center;gap:8px;margin-top:8px}
.hero-field-row .field-input{flex:1}
.btn-choose-hero{background:none;border:1px solid rgba(7,30,37,0.15);color:#4A7A7C;border-radius:8px;padding:7px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif;white-space:nowrap;flex-shrink:0}
.btn-choose-hero:hover{background:#4A7A7C;color:white}
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
.btn-cancel-edit{background:none;border:1px solid rgba(7,30,37,0.15);color:#8AACAE;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-cancel-edit:hover{background:#f0f4f4;color:#4A7A7C}
.btn-schedule{background:none;border:1px solid #D97706;color:#D97706;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-schedule:hover{background:#FEF3C7}
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
.btn-modal-stay{background:#C86030;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-modal-leave{background:none;border:1px solid rgba(7,30,37,0.15);color:#4A7A7C;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif}
/* SCHEDULE MODAL */
.schedule-modal-box{background:white;border-radius:16px;padding:28px;max-width:360px;width:90%}
.btn-schedule-confirm{background:#D97706;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-cancel-schedule{background:#C82030;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}/* IMAGE MANAGER */
.img-modal-overlay{position:fixed;inset:0;background:rgba(7,30,37,0.7);display:none;align-items:flex-start;justify-content:center;z-index:300;padding:40px 20px;overflow-y:auto}
.img-modal-overlay.active{display:flex}
.img-modal{background:white;border-radius:16px;width:100%;max-width:800px;max-height:85vh;display:flex;flex-direction:column}
.img-modal-header{padding:16px 20px;border-bottom:1px solid rgba(7,30,37,0.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.img-modal-title{font-size:16px;font-weight:800;color:#071E25}
.img-modal-actions{display:flex;gap:8px;align-items:center}
.btn-upload-img{background:#C86030;color:white;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif}
.btn-close-img{background:none;border:none;font-size:20px;color:#8AACAE;cursor:pointer;line-height:1;padding:0 4px}
.btn-close-img:hover{color:#071E25}
.img-modal-body{padding:16px;overflow-y:auto;flex:1}
/* FIX 1: Image Library grid */
.img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;padding:16px}
.img-cell{cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid transparent;transition:border-color 0.15s;aspect-ratio:16/9;background:#eee}
.img-cell:hover{border-color:#4A7A7C}
.img-cell:hover .img-cell-actions{opacity:1}
.img-cell img{width:100%;height:100%;object-fit:cover;display:block}
.img-cell-name{font-size:10px;color:#8AACAE;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:white}
.img-cell-actions{position:absolute;top:4px;right:4px;display:flex;gap:4px;opacity:0;transition:opacity 0.15s}
.img-cell-wrap{position:relative;aspect-ratio:16/9;overflow:hidden}
.img-cell-btn{background:rgba(7,30,37,0.8);color:white;border:none;border-radius:6px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;white-space:nowrap}
.img-cell-btn:hover{background:#071E25}
.img-cell-btn.danger{background:rgba(200,32,48,0.85)}
.img-cell-btn.danger:hover{background:#C82030}
.img-set-hero-btn{display:block;width:100%;background:rgba(7,30,37,0.06);border:none;color:#4A7A7C;font-size:10px;font-weight:600;cursor:pointer;padding:4px 6px;font-family:'Outfit',sans-serif;border-top:1px solid rgba(7,30,37,0.06)}
.img-set-hero-btn:hover{background:#4A7A7C;color:white}
/* FIX 2: Upload Queue */
.upload-queue{margin-bottom:16px}
.upload-queue-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.queue-thumb{position:relative;width:100px;height:70px;border-radius:6px;overflow:hidden;border:1.5px solid rgba(7,30,37,0.12);background:#eee;flex-shrink:0}
.queue-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.queue-thumb-name{position:absolute;bottom:0;left:0;right:0;font-size:9px;background:rgba(7,30,37,0.7);color:white;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.queue-thumb-remove{position:absolute;top:3px;right:3px;background:rgba(200,32,48,0.85);border:none;color:white;border-radius:4px;width:18px;height:18px;font-size:12px;line-height:18px;text-align:center;cursor:pointer;padding:0}
.queue-thumb-remove:hover{background:#C82030}
.btn-upload-queue{background:#C86030;color:white;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;width:100%}
.btn-upload-queue:hover:not(:disabled){background:#B05528}
.btn-upload-queue:disabled{background:#ccc;cursor:not-allowed}
.btn-done-upload{background:#22A855;color:white;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;width:100%}
.btn-done-upload:hover{background:#1a9040}
.upload-progress{background:#E0F0EE;border-radius:8px;padding:8px 12px;font-size:12px;color:#0A4840;margin-bottom:12px;display:none}
.upload-warning{background:#FFF4E0;border-radius:8px;padding:8px 12px;font-size:12px;color:#8A5800;margin-bottom:8px;display:none}
.img-empty{text-align:center;color:#8AACAE;font-size:13px;padding:40px}
/* DRAG AND DROP */
.img-drop-zone{border:2px dashed rgba(7,30,37,0.15);border-radius:10px;padding:24px;text-align:center;color:#8AACAE;font-size:13px;margin-bottom:16px;transition:all 0.15s;cursor:pointer}
.img-drop-zone:hover,.img-drop-zone.dragover{border-color:#4A7A7C;background:#f0f8f7;color:#4A7A7C}
/* SETTINGS */
.settings-section{background:white;border-radius:12px;border:0.5px solid rgba(7,30,37,0.07);padding:20px;margin-bottom:16px}
.settings-section-title{font-size:13px;font-weight:700;color:#071E25;margin-bottom:4px}
.settings-section-desc{font-size:11px;color:#8AACAE;margin-bottom:16px}
.settings-field{margin-bottom:14px}
.settings-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#4A7A7C;margin-bottom:6px}
.toggle-group{display:flex;gap:8px}
.toggle-opt{flex:1;padding:10px;border:1.5px solid rgba(7,30,37,0.12);border-radius:8px;font-size:12px;font-weight:600;color:#8AACAE;text-align:center;cursor:pointer;transition:all 0.15s;background:none;font-family:'Outfit',sans-serif}
.toggle-opt.active{border-color:#4A7A7C;color:#4A7A7C;background:#f0f8f7}
.btn-save-settings{background:#C86030;color:white;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;margin-top:8px}
.btn-save-settings:hover{background:#B05528}
.settings-saved{display:inline-block;font-size:12px;color:#22A855;font-weight:600;margin-left:10px;opacity:0;transition:opacity 0.3s}
/* FIX 3: BATCH UPLOAD */
.batch-drop-zone{border:2px dashed rgba(7,30,37,0.15);border-radius:12px;padding:48px 24px;text-align:center;color:#8AACAE;font-size:14px;transition:all 0.15s;cursor:pointer;background:white}
.batch-drop-zone:hover,.batch-drop-zone.dragover{border-color:#4A7A7C;background:#f0f8f7;color:#4A7A7C}
.batch-drop-icon{font-size:48px;margin-bottom:12px}
.batch-preview-card{background:white;border-radius:10px;border:0.5px solid rgba(7,30,37,0.07);padding:12px 16px;display:flex;align-items:center;gap:12px;margin-bottom:8px}
.batch-preview-thumb{width:60px;height:40px;object-fit:cover;border-radius:6px;background:#eee;flex-shrink:0}
.batch-preview-info{flex:1;min-width:0}
.batch-preview-title{font-size:13px;font-weight:600;color:#071E25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.batch-preview-meta{font-size:11px;color:#8AACAE;margin-top:2px}
.batch-progress-bar{height:6px;border-radius:3px;background:#E0F0EE;margin:8px 0}
.batch-progress-fill{height:100%;border-radius:3px;background:#4A7A7C;transition:width 0.3s}
.batch-result-item{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;border-bottom:1px solid rgba(7,30,37,0.06)}
.batch-result-ok{color:#22A855}
.batch-result-err{color:#C82030}
.batch-result-warn{color:#D97706}
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
<\/style>
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
Posts <span class="nav-badge" id="posts-badge">0<\/span>
<\/button>
<button class="nav-item" id="nav-new" onclick="openNewPost()">
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"/><\/svg>
New Post
<\/button>
<!-- DRAFTS SECTION - rendered by JS -->
<div id="sidebar-drafts"><\/div>
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
<h1 class="posts-title">Posts<\/h1>
<button class="btn-new-post" onclick="openNewPost()">+ New Post<\/button>
<\/div>
<input type="text" class="search-input" placeholder="Search posts..." oninput="filterPosts(this.value)">
<div class="posts-table" id="posts-table"><\/div>
<\/div>

<!-- Editor view -->
<div id="editor-view">
<button class="editor-back" onclick="cancelEdit()">
<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/><\/svg>
Posts
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
<button class="btn-replace-hero" onclick="openImageManager('hero')">Replace image<\/button>
<div style="margin-top:8px">
<div class="field-label" style="margin-bottom:4px">Hero Image URL<\/div>
<div class="hero-field-row">
<input type="text" class="field-input" id="f-hero-url" placeholder="https://..." oninput="onHeroUrlChange();markDirty()" style="font-size:11px">
<button class="btn-choose-hero" onclick="openImageManager('hero')">Choose from library<\/button>
<\/div>
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
<button class="btn-save-draft" id="btn-save-draft" onclick="savePost(false)">Save draft<\/button>
<button class="btn-schedule" id="btn-schedule" onclick="openScheduleModal()" style="display:none">Schedule<\/button>
<\/div>
<div class="action-bar-right">
<button class="btn-cancel-edit" onclick="cancelEdit()">Cancel<\/button>
<button class="btn-preview-post" onclick="previewPost()">Preview<\/button>
<button class="btn-publish" id="btn-publish" onclick="savePost(true)">Publish<\/button>
<\/div>
<\/div>
<\/div>

<!-- Images view -->
<div id="images-view" style="display:none">
<div class="posts-header">
<h1 class="posts-title">Image Library<\/h1>
<button class="btn-new-post" onclick="openImageManager('browse')">Upload Image<\/button>
<\/div>
<div id="images-inline-grid" style="margin-top:8px"><\/div>
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
<div style="font-size:32px;margin-bottom:16px">&#128197;<\/div>
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
<button class="btn-new-post" onclick="showView('posts');loadPosts()" style="margin-bottom:12px">Go to Drafts<\/button>
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
<script>
// ============================================================
// STATE
// ============================================================
const API_BASE = '';
let token = sessionStorage.getItem('tpcp_admin_token') || '';
let allPosts = [];
let currentPost = null;
let imgManagerContext = 'hero';
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

// ============================================================
// DIRTY TRACKING
// ============================================================
function markDirty() { isDirty = true; }

function cancelEdit() {
  if (!isDirty) { showView('posts'); return; }
  document.getElementById('unsaved-modal').classList.add('active');
}

function leaveWithoutSaving() {
  closeModal('unsaved-modal');
  isDirty = false;
  showView('posts');
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
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  initQuill();
  loadPosts();
  loadSettings();
}

function initQuill() {
  if (quill) return;
  const toolbarOptions = {
    container: [
      [{ 'header': false }, 'bold', 'italic'],
      [{ header: 2 }, { header: 3 }],
      [{ list: 'bullet' }, { list: 'ordered' }],
      ['link', 'image'],
      ['undo', 'redo']
    ],
    handlers: {
      image: function() { openImageManager('quill'); },
      undo: function() { document.execCommand('undo'); },
      redo: function() { document.execCommand('redo'); }
    }
  };
  quill = new Quill('#quill-editor', { theme: 'snow', modules: { toolbar: toolbarOptions } });
  const toolbar = document.querySelector('.ql-toolbar');
  if (toolbar) {
    const undoBtn = toolbar.querySelector('.ql-undo');
    const redoBtn = toolbar.querySelector('.ql-redo');
    if (undoBtn) undoBtn.innerHTML = '&#8634;';
    if (redoBtn) redoBtn.innerHTML = '&#8635;';
  }
  quill.on('text-change', () => { markDirty(); });
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
// ============================================================
// NAV / VIEWS
// ============================================================
function showView(v) {
  ['posts','editor','images','settings','batch'].forEach(id => {
    const el = document.getElementById(id + '-view');
    if (el) el.style.display = 'none';
  });
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const viewMap = {
    posts: { el: 'posts-view', nav: 'nav-posts' },
    editor: { el: 'editor-view', nav: 'nav-new' },
    images: { el: 'images-view', nav: 'nav-images', cb: loadImagesInline },
    settings: { el: 'settings-view', nav: 'nav-settings' },
    batch: { el: 'batch-view', nav: 'nav-batch' }
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
async function loadPosts() {
  try {
    const r = await fetch(API_BASE + '/api/blog-index');
    allPosts = await r.json();
    if (!Array.isArray(allPosts)) allPosts = [];
    renderPostList(allPosts);
    renderDraftsSidebar(allPosts);
    document.getElementById('posts-badge').textContent = allPosts.length;
  } catch(e) { showToast('Failed to load posts', 'error'); }
}

function renderDraftsSidebar(posts) {
  // Sort drafts: scheduled first (ascending), then plain drafts
  const drafts = posts.filter(p => !p.published).sort((a, b) => {
    if (a.scheduledAt && b.scheduledAt) return new Date(a.scheduledAt) - new Date(b.scheduledAt);
    if (a.scheduledAt) return -1;
    if (b.scheduledAt) return 1;
    return 0;
  });
  const container = document.getElementById('sidebar-drafts');
  if (!container) return;
  if (!drafts.length) { container.innerHTML = ''; return; }
  const items = drafts.map(d => {
    const scheduledBadge = d.scheduledAt
      ? '<span class="draft-pill-scheduled">Scheduled<\/span>'
      : '<span class="draft-pill">Draft<\/span>';
    const scheduledDate = d.scheduledAt
      ? '<div class="draft-scheduled-date">' + formatScheduledDate(d.scheduledAt) + '<\/div>'
      : '';
    return '<button class="draft-item" onclick="openPost(' + "'" + escHtml(d.slug) + "'" + ')">' +
      '<div class="draft-item-row"><span class="draft-item-title">' + escHtml(d.title || 'Untitled') + '<\/span>' + scheduledBadge + '<\/div>' +
      scheduledDate + '<\/button>';
  }).join('');
  container.innerHTML = '<div class="drafts-divider"><\/div><div class="drafts-section"><div class="drafts-label">Drafts<\/div>' + items + '<\/div>';
}

function renderPostList(posts) {
  const table = document.getElementById('posts-table');
  if (!posts.length) {
    table.innerHTML = '<div style="text-align:center;color:#8AACAE;padding:40px;font-size:14px">No posts yet.<\/div>';
    return;
  }
  const q = "'";
  table.innerHTML = posts.map(p => {
    const parkCls = p.park === 'dl' ? 'park-dl' : p.park === 'wdw' ? 'park-wdw' : 'park-both';
    const parkLabel = p.park === 'dl' ? 'Disneyland' : p.park === 'wdw' ? 'WDW' : 'Both';
    let statusCls, statusLabel;
    if (p.published) { statusCls = 'status-published'; statusLabel = 'Published'; }
    else if (p.scheduledAt) { statusCls = 'status-scheduled'; statusLabel = 'Scheduled'; }
    else { statusCls = 'status-draft'; statusLabel = 'Draft'; }
    const date = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
    return '<div class="post-row" onclick="openPost(' + q + p.slug + q + ')">' +
      '<img class="post-thumb" src="' + (p.heroImage||'') + '" alt="" loading="lazy" onerror="this.src=' + q + q + '">' +
      '<span class="post-title-cell">' + escHtml(p.title||'Untitled') + '<\/span>' +
      '<span class="park-pill ' + parkCls + '">' + parkLabel + '<\/span>' +
      '<span class="status-pill ' + statusCls + '">' + statusLabel + '<\/span>' +
      '<span class="post-date">' + date + '<\/span>' +
      '<div class="post-actions" onclick="event.stopPropagation()">' +
      '<button class="btn-edit" onclick="openPost(' + q + p.slug + q + ')">Edit<\/button>' +
      '<button class="btn-del" onclick="quickDelete(' + q + p.slug + q + ')">Delete<\/button>' +
      '<\/div><\/div>';
  }).join('');
}

function filterPosts(q) {
  if (!q) { renderPostList(allPosts); return; }
  const lq = q.toLowerCase();
  renderPostList(allPosts.filter(p => (p.title||'').toLowerCase().includes(lq) || (p.slug||'').toLowerCase().includes(lq)));
}

function formatScheduledDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + ' ' +
           d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  } catch(e) { return iso; }
}
// ============================================================
// EDITOR
// ============================================================
function openNewPost() {
  currentPost = null;
  clearEditor();
  isDirty = false;
  document.getElementById('btn-delete-post').style.display = 'none';
  document.getElementById('btn-schedule').style.display = 'none';
  showView('editor');
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
    // Show schedule button only for drafts
    const schedulBtn = document.getElementById('btn-schedule');
    if (!post.published) {
      schedulBtn.style.display = 'block';
      schedulBtn.textContent = post.scheduledAt ? ('Scheduled · ' + formatScheduledDate(post.scheduledAt)) : 'Schedule';
      schedulBtn.style.color = post.scheduledAt ? '#D97706' : '';
    } else {
      schedulBtn.style.display = 'none';
    }
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
  if (quill) quill.setContents([]);
  setFocal('center');
  applyReadTimeModeToField();
  updatePreviews();
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
  div.innerHTML = '<button class="faq-remove" onclick="this.parentElement.remove();markDirty()">&times;<\/button>' +
    '<div class="field-label" style="margin-bottom:6px">Question<\/div>' +
    '<input type="text" class="field-input" placeholder="Question" value="' + escHtml(q||'') + '" oninput="markDirty()" style="margin-bottom:8px">' +
    '<div class="field-label" style="margin-bottom:6px">Answer<\/div>' +
    '<textarea class="field-textarea" placeholder="Answer" rows="3" oninput="markDirty()">' + escHtml(a||'') + '<\/textarea>';
  list.appendChild(div);
}

// ============================================================
// RELATED
// ============================================================
function addRelatedRow(selectedSlug) {
  const list = document.getElementById('related-list');
  const div = document.createElement('div');
  div.className = 'related-row';
  const opts = allPosts.map(p => '<option value="' + p.slug + '" ' + (p.slug===selectedSlug?'selected':'') + '>' + escHtml(p.title||p.slug) + '<\/option>').join('');
  div.innerHTML = '<select onchange="markDirty()">' + opts + '<\/select><button class="related-remove" onclick="this.parentElement.remove();markDirty()">&times;<\/button>';
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
    readTime, publishedAt: existingPublishedAt || now, updatedAt: now,
    published: isPublished, scheduledAt, body: bodyHtml, faqs, related,
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
      isDirty = false;
      document.getElementById('f-readtime').value = post.readTime;
      document.getElementById('f-published').checked = post.published;
      document.getElementById('status-label').textContent = post.published ? 'Published' : 'Draft';
      document.getElementById('btn-delete-post').style.display = 'block';
      // Hide schedule button after publishing
      if (publish) document.getElementById('btn-schedule').style.display = 'none';
      showToast(publish ? 'Published &#10003;' : 'Saved &#10003;', 'success');
      await loadPosts();
    } else { showToast('Save failed &mdash; try again', 'error'); }
  } catch(e) { showToast('Save failed &mdash; try again', 'error'); }
  finally { btn.textContent = origText; btn.classList.remove('btn-loading'); btn.disabled = false; }
}

function previewPost() {
  const slug = document.getElementById('f-slug').value.trim();
  if (slug) window.open('/blog/' + slug, '_blank');
}

// ============================================================
// DELETE
// ============================================================
function quickDelete(slug) { currentPost = { slug }; confirmDelete(); }
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
      showView('posts'); await loadPosts();
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
    const d = new Date(currentPost.scheduledAt);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    dt.value = local;
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

async function confirmSchedule() {
  const dt = document.getElementById('schedule-datetime').value;
  if (!dt) { showToast('Pick a date and time', 'error'); return; }
  const scheduledAt = new Date(dt).toISOString();
  if (new Date(scheduledAt) <= new Date()) { showToast('Scheduled time must be in the future', 'error'); return; }
  const slug = document.getElementById('f-slug').value.trim() || (currentPost && currentPost.slug);
  if (!slug) { showToast('Save the post first', 'error'); return; }
  // Save draft first to persist any unsaved changes
  if (isDirty) {
    await savePost(false);
  }
  try {
    const r = await fetch(API_BASE + '/api/blog-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
      body: JSON.stringify({ slug, scheduledAt })
    });
    const data = await r.json();
    if (r.ok && data.success) {
      if (currentPost) currentPost.scheduledAt = scheduledAt;
      closeModal('schedule-modal');
      const btn = document.getElementById('btn-schedule');
      btn.textContent = 'Scheduled · ' + formatScheduledDate(scheduledAt);
      showToast('Scheduled for ' + formatScheduledDate(scheduledAt), 'success');
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
  renderUploadQueue();
  document.getElementById('img-modal').classList.add('active');
  setupDragDrop();
  loadImages();
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
        '<div class="queue-thumb-name">' + escHtml(item.file.name) + '<\/div>' +
        '<button class="queue-thumb-remove" onclick="removeFromQueue(' + idx + ')">&times;<\/button>' +
      '<\/div>'
    ).join('');
  }
  if (uploadDone) {
    if (btnUpload) {
      btnUpload.outerHTML = '<button class="btn-done-upload" onclick="doneUpload()">Done<\/button>';
    }
  } else {
    if (btnUpload) {
      btnUpload.textContent = 'Upload ' + uploadQueue.length + ' photo(s)';
      btnUpload.disabled = uploadQueue.length === 0;
    }
  }
}

function doneUpload() {
  forceCloseImageManager();
  loadImages();
  if (document.getElementById('images-view') && document.getElementById('images-view').style.display !== 'none') {
    loadImagesInline();
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
      if (warning) { warning.textContent = 'Large PNG detected — consider JPG for faster load'; warning.style.display = 'block'; }
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
  progress.textContent = successCount + ' of ' + total + ' uploaded &#10003;';
  uploadQueue = [];
  uploadDone = true;
  renderUploadQueue();
  loadImages();
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
          '<div class="img-cell-actions">' +
            '<button class="img-cell-btn" onclick="event.stopPropagation();copyImgUrl(' + "'" + escAttr(img.url) + "',this" + ')">Copy URL<\/button>' +
            '<button class="img-cell-btn danger" onclick="event.stopPropagation();deleteImage(' + "'" + escAttr(img.url) + "'" + ')">Delete<\/button>' +
          '<\/div>' +
        '<\/div>' +
        '<div class="img-cell-name">' + escHtml(img.filename) + '<\/div>' +
        '<button class="img-set-hero-btn" onclick="setHeroFromLibrary(' + "'" + escAttr(img.url) + "'" + ')">Set as hero<\/button>' +
      '<\/div>'
    ).join('');
  } catch(e) {
    grid.innerHTML = '<div style="color:#C82030;font-size:13px;padding:20px">Failed to load images.<\/div>';
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
  if (!confirm('Delete this image?')) return;
  fetch(API_BASE + '/api/blog-images', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
    body: JSON.stringify({ url })
  }).then(() => loadImages()).catch(() => showToast('Delete failed', 'error'));
}

function setHeroFromLibrary(url) {
  document.getElementById('hero-preview').src = url;
  document.getElementById('f-hero-url').value = url;
  document.getElementById('og-img').src = url;
  markDirty();
  forceCloseImageManager();
  showToast('Hero image set', 'success');
}

async function loadImagesInline() {
  const q = "'";
  const grid = document.getElementById('images-inline-grid');
  grid.innerHTML = '<div style="color:#8AACAE;font-size:13px">Loading...</div>';
  try {
    const r = await fetch(API_BASE + '/api/blog-images', { headers: { 'x-admin-key': token } });
    const images = await r.json();
    if (!images.length) { grid.innerHTML = '<div class="coming-soon">No images yet. Use Upload Image above.<\/div>'; return; }
    grid.innerHTML = '<div class="img-grid">' + images.map(img =>
      '<div class="img-cell" style="position:relative">' +
        '<div class="img-cell-wrap" onclick="openImageManager(' + q + 'browse' + q + ')">' +
          '<img src="' + escAttr(img.url) + '" alt="' + escAttr(img.filename) + '" loading="lazy">' +
          '<div class="img-cell-actions">' +
            '<button class="img-cell-btn" onclick="event.stopPropagation();copyImgUrl(' + "'" + escAttr(img.url) + "',this" + ')">Copy URL<\/button>' +
            '<button class="img-cell-btn danger" onclick="event.stopPropagation();deleteImage(' + "'" + escAttr(img.url) + "'" + ')">Delete<\/button>' +
          '<\/div>' +
        '<\/div>' +
        '<div class="img-cell-name">' + escHtml(img.filename) + '<\/div>' +
      '<\/div>'
    ).join('') + '<\/div>';
  } catch(e) { grid.innerHTML = '<div style="color:#C82030;font-size:13px">Failed to load images.<\/div>'; }
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
        '<\/div>' +
        '<div class="batch-preview-info">' +
          '<div class="batch-preview-title">' + escHtml(p.title || p.slug) + '<\/div>' +
          '<div class="batch-preview-meta">' +
            '<span class="park-pill ' + parkCls + '" style="font-size:7px;margin-right:6px">' + parkLabel + '<\/span>' +
            wordCount + ' words' +
            (!hasHero && heroPath ? ' &nbsp;&#9888; Missing hero image' : '') +
          '<\/div>' +
        '<\/div>' +
      '<\/div>';
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
  for (let i = 0; i < imgKeys.length; i++) {
    const relPath = imgKeys[i];
    if (progressLabel) progressLabel.textContent = 'Uploading images...';
    if (progressDetail) progressDetail.textContent = (i + 1) + ' of ' + imgKeys.length;
    if (progressFill) progressFill.style.width = Math.round(((i + 1) / imgKeys.length) * 50) + '%';
    try {
      const zipEntry = batchImages[relPath];
      const blob = await zipEntry.async('blob');
      const filename = relPath.split('/').pop();
      const mimeType = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.gif') ? 'image/gif' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      const r = await fetch(API_BASE + '/api/blog-upload-image', {
        method: 'POST',
        headers: { 'x-admin-key': token, 'x-filename': filename, 'Content-Type': mimeType },
        body: blob
      });
      const data = await r.json();
      if (r.ok && data.url) { imageUrlMap[relPath] = data.url; }
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
      post.body = post.body.replace(/src="(images\\/[^"]+)"/g, (m, p1) => {
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
      return '<div class="batch-result-item ' + cls + '"><span>' + icon + '<\/span><span>' + escHtml(r.msg) + '<\/span><\/div>';
    }).join('');
  }
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
<\/script>
<\/body>`;
