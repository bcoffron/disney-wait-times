// Test stub for @vercel/blob (upload suite): put echoes a public URL, list is
// empty (so the handler's duplicate check never triggers), del is a no-op.
export async function put(pathname, body, opts) {
  return { url: 'https://store.public.blob.vercel-storage.com/' + pathname, pathname };
}
export async function list() { return { blobs: [], hasMore: false, cursor: null }; }
export async function del() {}
