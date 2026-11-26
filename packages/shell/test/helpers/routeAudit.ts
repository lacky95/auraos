/**
 * The access audit of the real shell tree: every route, surface and listener
 * against the access manifest. One copy, read by route-access-manifest.test.ts
 * and by the security gate (tools/security-check.mjs), which runs it without
 * the test suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROUTE_ACCESS_MANIFEST } from '../../src/lib/access/routeManifest.ts';
import { SURFACE_MANIFEST } from '../../src/lib/access/surfaceManifest.ts';
import { attachedSurfaces, auditRoutes, auditSurfaces, enumerateRoutes, listenerSites } from './enumerateRoutes.ts';
import type { AuditIssue, AuditPolicy } from './enumerateRoutes.ts';

// Held here, apart from the manifest, so widening public takes two edits (Q27).
const STATIC_CANDIDATES = ['/api/os/theme.css', '/api/os/icons.svg', '/api/os/icons/[name].svg'];
const candidateKeys = STATIC_CANDIDATES.flatMap((r) => [`GET ${r}`, `HEAD ${r}`]);
export const POLICY: AuditPolicy = {
  publicRoutes: new Set([
    'GET /api/admin/first-boot', 'HEAD /api/admin/first-boot',
    'GET /api/auth/status', 'HEAD /api/auth/status', 'POST /api/auth/setup', 'POST /api/auth/login',
    'GET /api/auth/password-policy', 'HEAD /api/auth/password-policy',
    ...candidateKeys,
  ]),
  publicCandidates: new Set(candidateKeys),
  publicSurfaces: new Set(['shell-static-assets', 'page-setup', 'page-login']),
};
// Classified in SURFACE_MANIFEST as shell-listener, ws-proxy and sse-mux.
export const KNOWN_LISTENERS = [
  'server.mjs createServer',
  'server/attach.mjs WebSocketServer',
  'server/attach.mjs upgrade',
  'server/exec-bridge.mjs upgrade',
  'server/sse-mux.mjs WebSocketServer',
];

export interface ShellAccessAudit {
  /** API routes the walk found. */
  routes: number;
  issues: AuditIssue[];
  /** Listener sites that differ from KNOWN_LISTENERS, as `+site` (new) or `-site` (gone). */
  listeners: string[];
}

/** `shellRoot` is packages/shell. */
export function auditShellAccess(shellRoot: string): ShellAccessAudit {
  const inventory = enumerateRoutes(path.join(shellRoot, 'src/pages'));
  const attached = attachedSurfaces(fs.readFileSync(path.join(shellRoot, 'server/attach.mjs'), 'utf8'));
  const sites = listenerSites(shellRoot);
  return {
    routes: inventory.routes.filter((r) => r.route.startsWith('/api/')).length,
    issues: [
      ...auditRoutes(inventory, ROUTE_ACCESS_MANIFEST, POLICY),
      ...auditSurfaces(SURFACE_MANIFEST, attached, inventory.pages, POLICY),
    ],
    listeners: [
      ...sites.filter((s) => !KNOWN_LISTENERS.includes(s)).map((s) => `+${s}`),
      ...KNOWN_LISTENERS.filter((s) => !sites.includes(s)).map((s) => `-${s}`),
    ],
  };
}
