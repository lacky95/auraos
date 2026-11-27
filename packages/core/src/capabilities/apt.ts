/**
 * apt argv with signature verification forced on (D94 G8), whatever the
 * target's own apt.conf.d says: no unsigned repository or package gets
 * through, and there is no switch to allow one. One definition for every
 * privileged apt run (the PRoot module's `baseInstall` and `upgrade`
 * actions, the shell's capability installs). A leaf.
 */

export const APT_VERIFY_ARGS: readonly string[] = [
  '-o', 'Acquire::AllowInsecureRepositories=false',
  '-o', 'Acquire::AllowDowngradeToInsecureRepositories=false',
  '-o', 'APT::Get::AllowUnauthenticated=false',
];

/** `apt-get update` and `apt-get install -- <packages>` (or a checked local .deb path), verified. */
export const aptUpdateArgv = (): string[] => ['apt-get', ...APT_VERIFY_ARGS, 'update', '-qq'];
export const aptInstallArgv = (packages: readonly string[], opts: { recommends?: boolean } = {}): string[] =>
  ['apt-get', ...APT_VERIFY_ARGS, 'install', '-y', '-q', ...(opts.recommends ? [] : ['--no-install-recommends']), '--', ...packages];

/** apt's words for a signature it could not verify. */
export const UNVERIFIED_RE = /NO_PUBKEY|not signed|signature|cannot be authenticated|unauthenticated|is not valid yet|EXPKEYSIG/i;
export const UNVERIFIED_HINT = 'apt could not verify a repository or package signature. AuraOS never installs unverified packages: fix the keyring or sources and try again.';
