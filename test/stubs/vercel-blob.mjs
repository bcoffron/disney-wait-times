// In-memory stub for @vercel/blob, used only by the tests.
// State lives on globalThis so the test file can seed blobs and inspect
// del() calls: globalThis.__blobState = { blobs: Map, delCalls: [] }.
function state() {
  if (!globalThis.__blobState) {
    globalThis.__blobState = { blobs: new Map(), delCalls: [] };
  }
  return globalThis.__blobState;
}

export async function list({ prefix } = {}) {
  const st = state();
  const all = Array.from(st.blobs.values());
  const blobs = prefix ? all.filter(function (b) { return b.pathname.startsWith(prefix); }) : all;
  return { blobs };
}

export async function put(pathname, body) {
  const st = state();
  const url = 'https://blob.test/' + pathname;
  st.blobs.set(pathname, { pathname, url, size: body ? body.length : 0 });
  return { url, pathname };
}

export async function del(url) {
  const st = state();
  st.delCalls.push(url);
  for (const [k, b] of st.blobs) {
    if (b.url === url) st.blobs.delete(k);
  }
}
