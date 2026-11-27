#!/usr/bin/env node
// The maintainer's view of the one verifier: the same code install.sh, the
// release builder and the host recovery script run (os/release-verify.mjs).
// Without --keys/--key it trusts this checkout's os/release-keys/.
//   verify.mjs tag --repo . --tag v0.1.0 · select --repo . · files --meta F --sig F · tree DIR · fingerprint FILE
import { fileURLToPath } from 'node:url';
import { main as verifierMain } from '../../os/release-verify.mjs';

const shipped = fileURLToPath(new URL('../../os/release-keys', import.meta.url));
const argv = process.argv.slice(2);
const hasKeys = argv.some((x) => /^--(keys|key|pin)(=|$)/.test(x));
process.exitCode = verifierMain(hasKeys ? argv : [...argv, '--keys', shipped]);
