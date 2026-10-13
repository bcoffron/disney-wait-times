// Module resolution hooks for the blog-images DELETE handler tests.
// Redirects the handler's two external imports to in-repo stubs so the
// handler (and its real internal helpers: readPostBlob, buildUsageMap,
// stripQuery) can be exercised end to end with no network, no blob store,
// and no new dependencies. Registered from the test file via module.register.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/blob') {
    return { url: new URL('./stubs/vercel-blob.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === 'jsonwebtoken') {
    return { url: new URL('./stubs/jsonwebtoken.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
