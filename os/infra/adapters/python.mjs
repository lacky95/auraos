// pip / uv (D94 §5.2). Both read a SYSTEM config from $XDG_CONFIG_DIRS
// (pip: <dir>/pip/pip.conf, uv: <dir>/uv/uv.toml), below the user's
// ~/.config/pip and ~/.config/uv and a venv's pip.conf, which keep winning.
// PIP_CONFIG_FILE / PIP_INDEX_URL are not used: both override the user's files.
// `trusted-host` is emitted only for an explicit http:// index, never for
// HTTPS (D94 §7.5); uv gets no insecure-host setting at all.
import { corporateCas } from './trust.mjs';

export const name = 'python';

export function render(cfg, view) {
  const py = cfg.registries?.python;
  const corp = corporateCas(cfg, view.files);
  if (!py && !corp) return {};
  const pip = ['# AuraOS infrastructure configuration (D94): system layer, managed. User and venv pip.conf win.', '[global]'];
  const uv = ['# AuraOS infrastructure configuration (D94): system layer, managed. ~/.config/uv/uv.toml and the project win.'];
  if (py) {
    pip.push(`index-url = ${py.index}`);
    const u = new URL(py.index);
    if (u.protocol === 'http:') pip.push(`trusted-host = ${u.host}`);
  }
  if (corp) { pip.push(`cert = ${view.root}/ca-bundle.pem`); uv.push('native-tls = true'); }
  if (py) uv.push('', '[[index]]', `url = ${JSON.stringify(py.index)}`, 'default = true');
  return {
    files: { 'xdg/pip/pip.conf': `${pip.join('\n')}\n`, 'xdg/uv/uv.toml': `${uv.join('\n')}\n` },
    env: { XDG_CONFIG_DIRS: `${view.root}/xdg:/etc/xdg` },
  };
}

/** `infra_pip`: the index URL with its credential (a builder's per-operation PIP_INDEX_URL). */
export function secretFiles(cfg, view, resolve) {
  const py = cfg.registries?.python;
  const c = py?.credential ? resolve(py.credential.ref) : null;
  if (!c || c.kind !== 'basic') return {};
  const u = new URL(py.index);
  u.username = encodeURIComponent(c.user);
  u.password = encodeURIComponent(c.password);
  return { infra_pip: `${u.toString()}\n` };
}
