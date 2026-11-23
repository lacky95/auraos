/**
 * Static inventory of the shell's Astro routes, plus the audit of the access
 * manifest against it. Reads source only: importing a route would run it.
 *
 * Mirrors Astro 6 (core/routing/create-manifest.js, runtime/server/endpoint.js):
 * `_` and dot names are skipped, only the final extension is stripped (so
 * `theme.css.ts` is `/theme.css`), `index` collapses, and a request runs
 * `mod[method] ?? mod.ALL`, with HEAD falling back to GET.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import ts from 'typescript';
import { ACCESS_LEVELS, HTTP_METHODS, ROUTE_METHODS } from '../../src/lib/access/types.ts';
import type {
  AccessRule, AccessSurface, RouteAccessManifest, RouteMethod, RouteRefinement,
} from '../../src/lib/access/types.ts';

const HANDLER_NAMES = new Set<string>([...HTTP_METHODS, 'ALL']);
/** Likely-mistaken spellings of a handler, whatever their case. */
const HANDLER_LIKE = new Set<string>([...HANDLER_NAMES, 'DEL']);
const ENDPOINT_EXTENSIONS = new Set(['.ts', '.js']);
const PAGE_EXTENSIONS = new Set(['.astro', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn', '.md']);

export interface RouteInfo {
  route: string;
  /** Relative to the pages directory. */
  file: string;
  /** Handler exports, as written. */
  handlers: string[];
  /** Every method that reaches a handler, including implicit HEAD. */
  methods: RouteMethod[];
  /** Export forms the analysis can't vouch for. */
  problems: string[];
}

export interface PageInfo {
  route: string;
  file: string;
}

export interface RouteInventory {
  routes: RouteInfo[];
  pages: PageInfo[];
  /** Files or routes that can't be classified at all. */
  problems: string[];
}

export interface AuditIssue {
  code:
    | 'unanalyzable'
    | 'no-effective-rule'
    | 'all-without-method-rule'
    | 'stale-route'
    | 'stale-method'
    | 'stale-group'
    | 'public-not-allowed'
    | 'public-candidate-without-decision'
    | 'unlisted-helper'
    | 'stale-non-route'
    | 'ambiguous-without-decision'
    | 'decision-without-ambiguous'
    | 'invalid-rule'
    | 'surface-missing'
    | 'surface-stale';
  subject: string;
}

// ── exports ─────────────────────────────────────────────────────────────────

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);

/** The handler exports of one module, and every form that hides one. */
export function analyzeExports(fileName: string, text: string): { handlers: string[]; problems: string[] } {
  const kind = fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const handlers = new Set<string>();
  const problems: string[] = [];

  const parseErrors = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) problems.push('syntax error');

  /** A name exported in a form that can't be read as a plain handler. */
  const refuse = (name: string, form: string) => {
    if (HANDLER_LIKE.has(name.toUpperCase()) || http.METHODS.includes(name)) problems.push(`${form}: ${name}`);
  };
  const declared = (name: string) => {
    if (HANDLER_NAMES.has(name)) handlers.add(name);
    else if (HANDLER_LIKE.has(name.toUpperCase())) problems.push(`non-uppercase method export: ${name}`);
    else if (http.METHODS.includes(name)) problems.push(`non-standard method export: ${name}`);
  };

  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      if (!st.exportClause) { problems.push('export *'); continue; }
      if (ts.isNamespaceExport(st.exportClause)) { refuse(st.exportClause.name.text, 'export * as'); continue; }
      for (const el of st.exportClause.elements) {
        if (!el.isTypeOnly) refuse(el.name.text, 'export { }');
      }
      continue;
    }
    if (ts.isExportAssignment(st)) {
      if (st.isExportEquals) problems.push('export =');
      continue;
    }
    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword) || hasModifier(st, ts.SyntaxKind.DefaultKeyword)) continue;
    const ambient = hasModifier(st, ts.SyntaxKind.DeclareKeyword);

    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) problems.push('destructured export');
        else if (ambient) refuse(d.name.text, 'declare');
        else declared(d.name.text);
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      if (ambient) refuse(st.name.text, 'declare');
      else if (st.body) declared(st.name.text);    // a body-less overload has an implementation below
    } else if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) && st.name) {
      refuse(st.name.text, 'non-function export');
    } else if (ts.isImportEqualsDeclaration(st)) {
      refuse(st.name.text, 'export import');
    }
  }
  return { handlers: [...handlers].sort(), problems };
}

/** Every method Astro dispatches to one of these handlers. */
export function dispatchedMethods(handlers: readonly string[]): RouteMethod[] {
  if (handlers.includes('ALL')) return [...ROUTE_METHODS];
  const methods = new Set(handlers as RouteMethod[]);
  if (methods.has('GET')) methods.add('HEAD');
  return ROUTE_METHODS.filter((m) => methods.has(m));
}

// ── routes ──────────────────────────────────────────────────────────────────

export function enumerateRoutes(pagesDir: string): RouteInventory {
  const inventory: RouteInventory = { routes: [], pages: [], problems: [] };
  const seen = new Map<string, string>();

  const claim = (route: string, file: string) => {
    const other = seen.get(route);
    if (other) inventory.problems.push(`${file}: same route as ${other}`);
    seen.set(route, file);
  };

  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const ext = entry.isDirectory() ? '' : path.extname(entry.name);
      const name = ext ? entry.name.slice(0, -ext.length) : entry.name;
      if (name.startsWith('_')) continue;
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, [...segments, entry.name]); continue; }

      const file = path.relative(pagesDir, full).split(path.sep).join('/');
      const route = '/' + (name === 'index' ? segments : [...segments, name]).join('/');
      if (ENDPOINT_EXTENSIONS.has(ext)) {
        claim(route, file);
        const { handlers, problems } = analyzeExports(file, fs.readFileSync(full, 'utf8'));
        inventory.routes.push({ route, file, handlers, methods: dispatchedMethods(handlers), problems });
      } else if (PAGE_EXTENSIONS.has(ext)) {
        claim(route, file);
        inventory.pages.push({ route, file });
      } else {
        inventory.problems.push(`${file}: unknown page file type`);
      }
    }
  };
  walk(pagesDir, []);
  return inventory;
}

/** The group of `/api/<group>/…`. */
const groupOf = (route: string): string => route.split('/')[2] ?? '';

/** The rule for a method, before any variant applies. */
export function effectiveRule(
  manifest: RouteAccessManifest,
  info: Pick<RouteInfo, 'route' | 'handlers'>,
  method: RouteMethod,
): AccessRule | undefined {
  const methods = manifest.routes[info.route]?.methods;
  const own = methods?.[method];
  if (own) return own;
  if (method === 'HEAD' && !info.handlers.includes('ALL') && !info.handlers.includes('HEAD') && methods?.GET) return methods.GET;
  return manifest.groups[groupOf(info.route)];
}

const variantApplies = (methods: readonly RouteMethod[], method: RouteMethod, info: RouteInfo): boolean =>
  methods.includes(method)
  || (method === 'HEAD' && methods.includes('GET') && !info.handlers.includes('ALL') && !info.handlers.includes('HEAD'));

// ── audit ───────────────────────────────────────────────────────────────────

export interface AuditPolicy {
  /** `METHOD /route` that may be public. */
  publicRoutes: ReadonlySet<string>;
  /** The subset that is only a candidate, so it must carry a decision. */
  publicCandidates: ReadonlySet<string>;
  publicSurfaces: ReadonlySet<string>;
}

function auditRule(r: AccessRule, subject: string, issues: AuditIssue[]): void {
  if (r.allow.some((level) => !(ACCESS_LEVELS as readonly string[]).includes(level))) {
    issues.push({ code: 'invalid-rule', subject });
  }
  const noted = (r.decision?.note.trim().length ?? 0) > 0 && Number.isInteger(r.decision?.phase);
  if (r.ambiguous && !noted) issues.push({ code: 'ambiguous-without-decision', subject });
  if (!r.ambiguous && r.decision) issues.push({ code: 'decision-without-ambiguous', subject });
}

export function auditRoutes(
  inventory: RouteInventory,
  manifest: RouteAccessManifest,
  policy: AuditPolicy,
): AuditIssue[] {
  const issues: AuditIssue[] = inventory.problems.map((subject) => ({ code: 'unanalyzable', subject }));
  const byRoute = new Map(inventory.routes.map((r) => [r.route, r]));
  const usedGroups = new Set<string>();

  const checkPublic = (r: AccessRule, key: string) => {
    if (!r.allow.includes('public')) return;
    if (!policy.publicRoutes.has(key)) issues.push({ code: 'public-not-allowed', subject: key });
    else if (policy.publicCandidates.has(key) && !r.decision) {
      issues.push({ code: 'public-candidate-without-decision', subject: key });
    }
  };

  for (const info of inventory.routes) {
    for (const p of info.problems) issues.push({ code: 'unanalyzable', subject: `${info.file}: ${p}` });

    if (info.handlers.length === 0) {
      // Registered by Astro but answers 404 for every method.
      if (!(info.route in manifest.nonRoutes)) issues.push({ code: 'unlisted-helper', subject: info.route });
      continue;
    }
    if (info.route in manifest.nonRoutes) issues.push({ code: 'stale-non-route', subject: info.route });
    usedGroups.add(groupOf(info.route));

    const refinement: RouteRefinement | undefined = manifest.routes[info.route];
    for (const method of info.methods) {
      const key = `${method} ${info.route}`;
      if (info.handlers.includes('ALL') && !refinement?.methods?.[method]) {
        issues.push({ code: 'all-without-method-rule', subject: key });
      }
      const r = effectiveRule(manifest, info, method);
      if (!r) { issues.push({ code: 'no-effective-rule', subject: key }); continue; }
      checkPublic(r, key);
      for (const v of refinement?.variants ?? []) {
        if (variantApplies(v.methods, method, info)) checkPublic(v.rule, `${key}#${v.id}`);
      }
    }
  }

  for (const [route, refinement] of Object.entries(manifest.routes)) {
    const info = byRoute.get(route);
    if (!info || info.handlers.length === 0) { issues.push({ code: 'stale-route', subject: route }); continue; }
    for (const [method, r] of Object.entries(refinement.methods ?? {})) {
      if (!info.methods.includes(method as RouteMethod)) issues.push({ code: 'stale-method', subject: `${method} ${route}` });
      auditRule(r, `${method} ${route}`, issues);
    }
    for (const v of refinement.variants ?? []) {
      for (const method of v.methods) {
        if (!info.methods.includes(method)) issues.push({ code: 'stale-method', subject: `${method} ${route}#${v.id}` });
      }
      auditRule(v.rule, `${route}#${v.id}`, issues);
    }
  }

  for (const [group, r] of Object.entries(manifest.groups)) {
    if (!usedGroups.has(group)) issues.push({ code: 'stale-group', subject: group });
    if (r.allow.includes('public')) issues.push({ code: 'public-not-allowed', subject: `group ${group}` });
    auditRule(r, `group ${group}`, issues);
  }
  for (const route of Object.keys(manifest.nonRoutes)) {
    if (!byRoute.has(route)) issues.push({ code: 'stale-non-route', subject: route });
  }
  return issues;
}

// ── surfaces ────────────────────────────────────────────────────────────────

/**
 * What `attachShellServers` puts on the HTTP server: the functions it calls,
 * and any direct `httpServer.x(...)` call, which is a surface of its own.
 */
export function attachedSurfaces(source: string): string[] {
  const sf = ts.createSourceFile('attach.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = sf.statements.find((s): s is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(s) && s.name?.text === 'attachShellServers');
  if (!fn?.body) throw new Error('attachShellServers not found');

  const calls = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) calls.add(node.expression.text);
      else calls.add(node.expression.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return [...calls].sort();
}

export function auditSurfaces(
  surfaces: readonly AccessSurface[],
  attached: readonly string[],
  pages: readonly PageInfo[],
  policy: Pick<AuditPolicy, 'publicSurfaces'>,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const attachNames = new Set(surfaces.flatMap((s) => s.attach ?? []));
  const pageRoutes = new Set(surfaces.flatMap((s) => s.page ?? []));
  const liveAttach = new Set(attached);
  const livePages = new Set(pages.map((p) => p.route));

  for (const name of attached) {
    if (!attachNames.has(name)) issues.push({ code: 'surface-missing', subject: name });
  }
  for (const p of pages) {
    if (!pageRoutes.has(p.route)) issues.push({ code: 'surface-missing', subject: `page ${p.route}` });
  }
  for (const s of surfaces) {
    if (s.attach && !liveAttach.has(s.attach)) issues.push({ code: 'surface-stale', subject: s.id });
    if (s.page && !livePages.has(s.page)) issues.push({ code: 'surface-stale', subject: s.id });
    if (s.rule.allow.includes('public') && !policy.publicSurfaces.has(s.id)) {
      issues.push({ code: 'public-not-allowed', subject: s.id });
    }
    auditRule(s.rule, s.id, issues);
  }
  return issues;
}
