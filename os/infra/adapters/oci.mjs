// OCI / Docker client (D94 §5.2, §6.5). Image references AuraOS pulls go
// through registries.oci.mirrors (imageRef); the image build gets the Docker
// Hub prefix as a build arg (DOCKER_IO_REGISTRY). Registry credentials are a
// per-operation docker config.json (DOCKER_CONFIG for oras / docker pull,
// IC-5), never an image layer or a home. The host daemon's own proxy, trust
// and mirrors are operator-owned (O6): AuraOS only checks and instructs.
import { rewriteImage } from '../config.mjs';

export const name = 'oci';

/** An image reference through the configured mirrors. */
export const imageRef = (ref, cfg) => rewriteImage(ref, cfg?.registries?.oci?.mirrors ?? {});

/** The Dockerfile's registry prefix args (`FROM ${DOCKER_IO_REGISTRY}/library/node:…`). */
export function buildArgs(cfg) {
  const m = cfg?.registries?.oci?.mirrors?.['docker.io'];
  return m ? { DOCKER_IO_REGISTRY: m.replace(/\/+$/, '') } : {};
}

export function render(cfg) {
  const mirrors = cfg.registries?.oci?.mirrors ?? {};
  const keys = Object.keys(mirrors).sort();
  if (!keys.length) return {};
  return { files: { 'oci/mirrors': `${keys.map((k) => `${k}\t${mirrors[k].replace(/\/+$/, '')}`).join('\n')}\n` } };
}

/** `infra_docker_config`: a docker config.json with the registry logins (per operation, not for builds). */
export function secretFiles(cfg, view, resolve) {
  const auths = {};
  for (const [host, v] of Object.entries(cfg.registries?.oci?.credentials ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const c = resolve(v.ref);
    if (c?.kind === 'basic') auths[host] = { auth: Buffer.from(`${c.user}:${c.password}`).toString('base64') };
  }
  return Object.keys(auths).length ? { infra_docker_config: `${JSON.stringify({ auths }, null, 2)}\n` } : {};
}
