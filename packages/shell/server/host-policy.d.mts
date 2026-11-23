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
export function classifyHost(host: unknown): HostClass;
export function hostPolicy(env?: Env): 'report' | 'enforce';
