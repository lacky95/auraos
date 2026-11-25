export interface EdgeView { scheme: 'http' | 'https'; host: string; origin: string; fromEdge: boolean }
export type HostClass =
  | { kind: 'app'; label: string; base: string; desktop: unknown }
  | { kind: 'shell'; internal: boolean; desktop: unknown }
  | { kind: 'unknown'; reason: string; label?: string };
type Env = Record<string, string | undefined>;
export function isTrustedProxy(peer: unknown, env?: Env): boolean;
export function originOf(scheme: string, host: string): string;
export function edgeView(request: { peer: unknown; encrypted?: boolean; header: (name: string) => unknown }, env?: Env): EdgeView;
export function requestEdge(req: unknown, env?: Env): EdgeView;
export function hostParses(host: unknown): boolean;
export function classifyHost(host: unknown): HostClass;
export function hostPolicy(env?: Env): 'report' | 'enforce';
export function desktopHosts(env?: Env): Set<string>;
export function hostListed(host: HostClass, env?: Env): boolean;
export const SAME_ORIGIN_HEADER: string;
export const OWN_API_RE: RegExp;
export function browserBoundaryError(
  req: { method?: string; headers: Record<string, unknown> },
  opts: {
    policy: 'shell' | 'app' | 'own-origin' | 'gateway';
    origin: string | ((origin: string) => boolean);
    path?: string; upgrade?: boolean; csrf?: boolean;
  },
): string | null;
export function isShellOrigin(origin: unknown, req: { headers: Record<string, unknown> }): boolean;
export function plainProxyPath(path: string): boolean;
export function browserDocumentRequest(method: string | undefined, header: (name: string) => unknown): boolean;
