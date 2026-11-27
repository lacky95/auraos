# Trusted release keys (D71)

The Ed25519 public keys (`*.pub`, PEM) that sign AuraOS releases, and
`revoked.txt` (revoked key ids, one per line). The verifier
(`os/release-verify.mjs`) trusts the keys of the **running** release or the
installer's own copy, never those of the release it is verifying. A release
signed by a trusted key that adds a key here introduces its successor
(rotation); listing a key id in `revoked.txt` revokes it everywhere.

No key is shipped yet: the maintainer adds the public half of the release key
here (`node tools/release/sign.mjs --key … --export-public`). Until then a
`stable` install needs `install.sh --trusted-key <file>`. The private key never
enters this repository or any AuraOS system. See `tools/release/README.md`.
