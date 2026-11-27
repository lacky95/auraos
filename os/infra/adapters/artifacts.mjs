// Generic downloads (D94 §5.2; audit #8, G3): registries.artifacts.rewrites
// as a table, longest prefix first, for shell consumers (the image build's
// aura_url in os/infra/build-env.sh, same rule as config.mjs rewriteUrl).
export const name = 'artifacts';

export function render(cfg) {
  const rw = cfg.registries?.artifacts?.rewrites ?? {};
  const keys = Object.keys(rw).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (!keys.length) return {};
  return { files: { 'artifacts.rewrites': `${keys.map((k) => `${k}\t${rw[k]}`).join('\n')}\n` } };
}
