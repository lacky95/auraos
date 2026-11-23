# AuraOS smoke test

A strictly read-only check of a running AuraOS. It uses Node 22 built-ins and has no dependencies.

```sh
node tools/smoke/run.mjs --target http://127.0.0.1:3000
node tools/smoke/run.mjs --target http://127.0.0.1:3000 --json /data/aura/baselines/smoke.json
node --test tools/smoke/test/*.test.mjs    # self-tests, no real AuraOS needed
```

| Option | Meaning |
|---|---|
| `--target <url>` | Shell origin. Required. |
| `--json <file>` | Also write the report, mode 0600. Refused inside `/workspace`. |
| `--tier live\|test-instance` | Default `live`. |

Exit codes: `0` no failures, `1` a check failed, `2` usage error.

## Safety model

- **One allowlist.** `ALLOWED_LIVE_REQUESTS` in `lib/guard.mjs` is the complete list of requests. The guard runs before sending and refuses every other method and path. Paths are compared as raw strings, so encoded or dotted variants fail.
- **GET is not assumed safe.** Some GETs cold-start apps, rewrite job files, start containers, or load Nexus sources. A denylist blocks these even if the allowlist is edited by mistake.
- **Ids come from discovery.** Instance paths accept only resumed, non-pool instances found in `GET /api/apps`.
- **The Terminal is never proxied by app id.** A bare `/api/proxy/com.aura.terminal/api/sessions` can cold-start it. The exact instance id cannot.
- **The CLI is guarded too.** `aura` runs against a loopback proxy that applies the same guard, with a minimal environment and no inherited tokens. `aura get apps` also requests `/api/apps/serve`, which is refused, and the CLI tolerates that.
- **No credentials are sent.** There are no tokens or cookies, and redirects are not followed.
- **Reports hold no secrets.** They contain statuses, counts, field presence, and non-secret ids. Response bodies, env values, logs, and notification content are never copied. Credential and binary checks use `test -e` only.
- **State guard.** Instance ids, instance states, and Terminal session ids are recorded before and after the run. Any change fails the run. Activity by someone else during the run will also trip it, so rerun on a quiet system before treating it as a bug.

## Tiers

`live` runs the read-only checks. Workflows that change state or need fixtures are tagged `test-instance` and reported as skipped: PTY attach, MCP handshake, Activities, Flights, TerminalX embed, Nexus install and update, jump, sidecar/mount/port changes, KV writes, and update/rollback.

`--tier test-instance` runs the same read-only checks. **The fixture workflows are not automated yet**, so they are still reported as skipped and do not count as passing. Use [MANUAL.md](MANUAL.md) for them.
