# Cutting and signing an AuraOS release (D71)

AuraOS releases stay plain Git: a release is an annotated tag `vX.Y.Z` on `main`
that carries signed metadata. Nothing else is published, and no external signing
service or PKI is involved. Installs (`install.sh`), updates (the release builder)
and rollbacks (`release-ctl.sh`) verify that metadata **before any code of the
release runs**, with the one dependency-free verifier `os/release-verify.mjs`.

| Tool | Runs where | Does |
|---|---|---|
| `tools/release/cut.mjs` | a clean `main` checkout | sets `package.json` `version`, commits `release: vX.Y.Z`, writes `release-meta.json` for that exact commit and tree; later `cut.mjs tag` creates the tag |
| `tools/release/sign.mjs` | **the maintainer's own machine, never inside AuraOS** | signs `release-meta.json` with the Ed25519 private key → `release-meta.sig` |
| `tools/release/verify.mjs` | anywhere | the same verifier the installer runs (trusts this checkout's `os/release-keys/` unless `--keys`/`--key` is given) |

## The flow

```sh
# 1. On a clean, up-to-date main (CI green). The key id is printed by sign.mjs --export-public.
node tools/release/cut.mjs 0.1.0-alpha.1 --key-id 0123456789abcdef \
     [--security --severity high --advisory AURA-2026-001] [--supersedes 0.0.49] [--min-from 0.0.40] [--notes-file notes.md]
#    → ../auraos-release-v0.1.0-alpha.1/release-meta.json (outside the checkout)

# 2. On the maintainer machine (copy the metadata file there; the key never moves):
node tools/release/sign.mjs --key ~/keys/auraos-release.pem --meta release-meta.json
#    → release-meta.sig

# 3. Back in the checkout: verify and tag (refuses a bad signature), then publish.
node tools/release/cut.mjs tag --meta ../auraos-release-v0.1.0-alpha.1/release-meta.json --sig release-meta.sig
git push origin main v0.1.0-alpha.1
node tools/release/verify.mjs select --repo .      # what a fresh install would pick
```

**Maturity is separate from trust** (owner, Phase 8 decision 5). Every release is a signed
tag, whatever its maturity; the version names it: `0.1.0-alpha.1` → `alpha` (the first
public release), `0.1.0-beta.1` / `0.1.0-rc.1` → `beta`, `0.1.0` → `stable`. The signed
`maturity` field must match. The **channel** is about trust: `signed` follows signed tags
only (default), `main` is the unsigned development head (owner opt-in). Within the signed
channel an install or update takes the newest release at or above its maturity floor
(`install.sh --maturity alpha|beta|stable`). **The default floor is `alpha` for now** (only
alpha releases exist; always signed); it moves to a higher floor once beta/stable releases
exist. It never accepts an unsigned tag, and never falls back to an older release when the
newest one fails (no silent downgrade). No separate pipeline or artifact per maturity
exists.

## Formats

`release-meta.json` v1 (unknown fields are refused; a new field means v2):

```json
{ "v": 1, "product": "auraos", "version": "0.1.0",
  "commit": "<full commit id>", "gitTree": "<that commit's tree id>",
  "maturity": "stable", "publishedAt": "2026-11-27T12:00:00Z",
  "securityUpdate": false, "severity": "high", "advisories": ["AURA-2026-001"],
  "supersedes": ["0.0.49"], "minFrom": "0.0.40", "notes": "…", "keyId": "0123456789abcdef" }
```

- `commit` **and** `gitTree` bind the signature to the exact revision and its contents.
  A release tree has no `.git`; the builder checks a staged `git archive` with
  `gitTreeOfDir()` (the same tree id git computes).
- `securityUpdate` needs a `severity`; `advisories`/`supersedes` feed the rollback rule
  "never reintroduce a fixed vulnerability" (stream U). They are honoured only when signed.

`release-meta.sig`: `{"v":1,"alg":"ed25519","keyId":"…","sig":"<base64>"}` over
`"AURAOS-RELEASE-META-V1\n"` + the exact bytes of `release-meta.json`. Both travel
base64-armored in the tag message, so no byte can drift.

Provenance (shown by `aura status`, Settings → About, diagnostics, the installer):
`upstream-signed` (a verified signed release of any maturity, no local patches), `upstream-unsigned`
(the `main` channel), `locally-modified` (any system patch series, or a Developer
checkout). A locally modified system is **never** labelled signed (`provenanceOf`,
`showsAsSigned`, `provenanceLabel` in the verifier).

## Keys

- **The private key never enters AuraOS** (no repository, no `/data`, no container, no
  release). `sign.mjs` refuses to run inside AuraOS, refuses a key file inside a git
  working tree and one readable by group or others. Create it on the maintainer machine:
  `openssl genpkey -algorithm ed25519 -out ~/keys/auraos-release.pem && chmod 600 ~/keys/auraos-release.pem`
  (encrypt it at rest with `-aes256` and pass `--passphrase-env VAR` to `sign.mjs`).
- **Public keys** live in `os/release-keys/*.pub` (PEM). `sign.mjs --key … --export-public`
  writes one named after its key id; commit it. The key id is the first 16 hex digits
  of sha256 over the raw key; installers print the full fingerprint for confirmation.
- **Which keys a verifier trusts:** the keys of the *verifying* side, never of the release
  being verified: the installer's own `os/release-keys/` (pinned with
  `install.sh --trusted-key`), the running release's `os/release-keys/` (updates,
  rollback), plus keys the host operator added (Stage 1b: the D64 record
  `release-trusted-keys`, `release-ctl.sh trust-key`).
- **Rotation:** add the successor's `.pub` in a release signed with the current key. Once
  that release verified (or runs), releases signed with the successor verify too. A fresh
  install with an older installer follows the chain through the older signed tags.
- **Revocation:** list the key id in `os/release-keys/revoked.txt` in a release signed by
  another trusted key; from then on nothing signed with it verifies (also rollbacks to
  releases it signed). A lost or compromised key with no successor is replaced by the
  operator explicitly (`--trusted-key` at install; `aura release keys add|revoke` /
  `release-ctl.sh trust-key` once Stage 1b lands).

## The version-bump hooks (D36)

`.githooks/pre-commit` and `.githooks/post-merge` bump the patch version on every commit
to, or merge into, `main`. `cut.mjs` replaces them: the version moves once per release
(`cut.mjs` commits with the hooks off, `AURA_NO_BUMP=1 --no-verify`). The displayed
version comes from `release.json` (Normal Mode) or `package.json` (Developer Mode).
Retiring the hooks is a deploy step with the owner (plan question e), not part of this
change: delete `.githooks/` and run `git config --unset core.hooksPath` on live.
