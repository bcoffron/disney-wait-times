// api/blog-admin.js — GET /admin — returns admin panel HTML shell
// Auth is handled client-side; this just serves the HTML

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Theme Park Co-Pilot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,900;1,9..144,900&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="icon" href="https://app.themeparkcopilot.com/assets/brand/favicon.PNG">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Outfit',sans-serif;background:#071E25;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px}
    .admin-logo{width:48px;height:48px;border-radius:12px;overflow:hidden;border:2px solid rgba(245,166,35,0.4);margin-bottom:20px}
    .admin-logo img{width:100%;height:100%;object-fit:cover}
    .admin-brand{font-size:13px;font-weight:800;color:#F5A623;letter-spacing:.04em;margin-bottom:8px}
    .admin-brand span{color:rgba(245,166,35,0.6)}
    .admin-title{font-family:'Fraunces',serif;font-size:32px;font-weight:900;color:#fff;margin-bottom:12px;text-align:center}
    .admin-sub{font-size:14px;color:rgba(255,255,255,0.45);text-align:center;max-width:360px;line-height:1.6}
    .admin-badge{display:inline-block;background:rgba(245,166,35,0.15);border:1px solid rgba(245,166,35,0.3);color:#F5A623;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-radius:100px;padding:6px 16px;margin-top:28px}
    .admin-back{display:block;margin-top:24px;font-size:12px;color:rgba(255,255,255,0.35);text-decoration:none}
    .admin-back:hover{color:rgba(255,255,255,0.65)}
  </style>
</head>
<body>
  <div class="admin-logo"><img src="https://app.themeparkcopilot.com/assets/brand/favicon.PNG" alt="Theme Park Co-Pilot"></div>
  <div class="admin-brand">Theme Park Co<span>✦</span>Pilot</div>
  <h1 class="admin-title">Blog Admin</h1>
  <p class="admin-sub">The full admin UI is coming in Step 4 — post editor, publish controls, and media management.</p>
  <div class="admin-badge">Coming in Step 4</div>
  <a href="/blog" class="admin-back">← Back to blog</a>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  return res.status(200).send(html);
};