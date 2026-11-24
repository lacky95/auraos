// Where Aura Docs is served, per frame route (Phase 2). One place for the
// base path, so next.config.mjs, serve.mjs and the search URL in
// app/layout.tsx can't disagree.
//
//   proxy  the shell loads the window at /api/proxy/<instanceId>/ and, with
//          the manifest's `proxy.preservePrefix`, forwards that prefix, so
//          Next's basePath must be it. The machine paths (the lifecycle
//          calls and the agents' MCP at /api/proxy/com.aura.docs/mcp) also
//          arrive this way, on both routes.
//   host   the app's own App Host serves it from `/`. The router marks those
//          requests with FRAME_ROUTE_HEADER, and removes the header from
//          every other request.
//
// A Next basePath is fixed at build time, so one build can't answer both
// routes: serve.mjs keeps one build per route and picks by the header.

/**
 * `APP_HOST_ROUTE_HEADER` from @aura/core/host-rules. It selects URLs and
 * grants nothing. Copied, not imported: this file runs in next.config.mjs
 * and serve.mjs, outside the SDK's export map. test/base-path.test.mjs
 * fails if it drifts.
 */
export const FRAME_ROUTE_HEADER = 'x-aura-frame-route';

/** @param {Record<string, string | undefined>} [env] */
export function docsInstanceId(env = process.env) {
  return env.APP_INSTANCE_ID || env.APP_ID || 'com.aura.docs';
}

/** `host` or `proxy`; anything else is today's `proxy`. */
export function frameRouteOf(value) {
  return value === 'host' ? 'host' : 'proxy';
}

/** The route of an incoming request, from its (Node or plain-object) headers. */
export function requestRoute(headers) {
  const v = headers?.[FRAME_ROUTE_HEADER];
  return frameRouteOf(Array.isArray(v) ? v[0] : v);
}

/** Next's basePath for a build that serves `route`. */
export function docsBasePath(route, instanceId) {
  // PHASE2-CUTOVER: the proxy prefix goes with the proxy route; only '' remains, and the manifest
  // drops `proxy.preservePrefix` so the shell strips the prefix from the lifecycle and MCP machine paths.
  return frameRouteOf(route) === 'host' ? '' : `/api/proxy/${instanceId}`;
}

/**
 * The search endpoint for the dialog. fumadocs-core builds its default as
 * `new URL('/api/search', location.origin)`, which ignores basePath, so it
 * is always passed explicitly.
 */
export function docsSearchApi(basePath) {
  return `${basePath}/api/search`;
}
