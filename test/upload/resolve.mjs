// Test-only module resolution: redirects the handler's external imports to
// the in-repo stubs so the suite runs with zero installed dependencies.
const map = {
  '@vercel/blob': new URL('./stubs/vercel-blob.mjs', import.meta.url).href,
  'jsonwebtoken': new URL('./stubs/jsonwebtoken.mjs', import.meta.url).href,
  'busboy': new URL('./stubs/busboy.mjs', import.meta.url).href,
};
export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: map[specifier], shortCircuit: true };
  return next(specifier, context);
}
