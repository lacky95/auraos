// AuraOS's own default endpoints (philosophy audit #7): the official Nexus
// store index, the repository behind it, and the GitHub web and API bases
// that `aura nexus app submit` and the store's screenshots use. Only the
// configured ones are rendered (`endpoints.json`); the kernel keeps the
// built-in public defaults for the rest (core infra/endpoints.ts), and under
// infra-public-fallback=deny a public default is refused, never used silently.
export const name = 'endpoints';

export const KEYS = Object.freeze(['github', 'githubApi', 'nexusIndex', 'nexusStoreRepo']);

export function render(cfg) {
  const e = cfg.endpoints ?? {};
  const out = Object.fromEntries(KEYS.filter((k) => typeof e[k] === 'string').map((k) => [k, k === 'nexusIndex' || k === 'nexusStoreRepo' ? e[k] : e[k].replace(/\/+$/, '')]));
  if (!Object.keys(out).length) return {};
  return { files: { 'endpoints.json': `${JSON.stringify(out, null, 2)}\n` } };
}
