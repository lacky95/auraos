// Fixtures for the D94 tests: the plan's example config, throwaway test
// certificates and credential files holding canary values (never real secrets).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './release-fixtures.mjs';

// The D94 plan's own example (§4.2), verbatim apart from the file paths.
export const EXAMPLE = `version: 1
network:
  proxy:
    http:  http://proxy.corp.example:3128        # no userinfo allowed in URLs
    https: http://proxy.corp.example:3128
    noProxy: [".corp.example", "10.0.0.0/8", "artifactory.corp.example"]   # internal names appended
    credential: { ref: "bootstrap:proxy" }       # Basic auth
  dns: host
trust:
  caCertificates:
    - { name: corp-root, file: ./certs/corp-root.pem }
  publicRoots: keep
clientCertificates:
  - name: artifactory-mtls
    hosts: [artifactory.corp.example]
    certificate: { file: ./certs/aura-system.crt }
    key: { ref: "bootstrap:artifactory-mtls-key" }
    identity: system
registries:
  npm:    { url: https://artifactory.corp.example/api/npm/npm-remote/,
            scopes: { "@corp": https://artifactory.corp.example/api/npm/npm-local/ },
            credential: { ref: "bootstrap:artifactory" } }
  python: { index: https://artifactory.corp.example/api/pypi/pypi-remote/simple,
            credential: { ref: "bootstrap:artifactory" } }
  apt:    { mirrors: { "deb.debian.org": https://artifactory.corp.example/debian-remote,
                       "security.debian.org": https://artifactory.corp.example/debian-security-remote },
            credential: { ref: "bootstrap:artifactory" } }
  oci:    { mirrors: { "docker.io": artifactory.corp.example/docker-remote,
                       "ghcr.io":   artifactory.corp.example/ghcr-remote },
            credentials: { "artifactory.corp.example": { ref: "bootstrap:artifactory" } } }
  git:    { rewrites: { "https://github.com/": "https://git.corp.example/mirror/github/" },
            credential: { ref: "bootstrap:git" } }
  artifacts:
          { rewrites: { "https://github.com/": "https://artifactory.corp.example/github-releases/",
                        "https://download.docker.com/": "https://artifactory.corp.example/docker-static/" } }
policy:
  publicFallback: deny
  proxy: configured
`;

export const CANARY = { proxy: 'proxy-user:Pr0xy-CANARY-pass', artifactory: 'art:ART-CANARY-tok3n', git: 'gituser:GIT-CANARY-pw' };

/** A config dir (certs) and a credentials dir (0600 files) for EXAMPLE. */
export function exampleFixture(config = EXAMPLE) {
  const dir = tmp('aura-infra-');
  mkdirSync(join(dir, 'certs'));
  const key = join(dir, 'ca.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', key, '-out', join(dir, 'certs/corp-root.pem'), '-days', '90', '-subj', '/CN=Corp Test Root'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', key, '-out', join(dir, 'certs/aura-system.crt'), '-days', '90', '-subj', '/CN=aura-system'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'infra.yaml'), config);
  const creds = tmp('aura-creds-');
  for (const [n, v] of Object.entries(CANARY)) writeFileSync(join(creds, n), `${v}\n`, { mode: 0o600 });
  writeFileSync(join(creds, 'artifactory-mtls-key'), execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519']), { mode: 0o600 });
  for (const f of readdirSync(creds)) chmodSync(join(creds, f), 0o600);
  return { dir, file: join(dir, 'infra.yaml'), creds };
}

