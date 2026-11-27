/**
 * The PRoot module's read-only diagnostics (5b PR): what `GET
 * /api/admin/proot-info`, `/api/admin/inspect-rootfs` and the PRoot rows of
 * `/api/admin/bench-sandbox` report, moved here from the shell routes
 * unchanged. Each probe is a fixed `sh -c` string over the module's own base
 * rootfs (no request input reaches it), run on the executor the route hands
 * in; a failing probe reports `<error: …>` instead of failing the action.
 */
import type { RuntimeAction, RuntimeActionHost } from '../ari.js';

function probe(host: RuntimeActionHost, cmd: string, max = 200): string {
  try { return host.run('sh', ['-c', cmd], { timeoutMs: 10_000 }).trim(); }
  catch (e) { return `<error: ${(e as Error).message.slice(0, max)}>`; }
}

function timeMs(host: RuntimeActionHost, cmd: string, iterations: number): { mean_ms: number; min_ms: number; max_ms: number } {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    try { host.run('sh', ['-c', cmd], { timeoutMs: 10_000 }); } catch { /* keep timing on failure */ }
    samples.push(Number(process.hrtime.bigint() - t0) / 1_000_000);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { mean_ms: +mean.toFixed(2), min_ms: +Math.min(...samples).toFixed(2), max_ms: +Math.max(...samples).toFixed(2) };
}

export function prootDiagnostics(baseRootfs: string): Record<'info' | 'inspectRootfs' | 'bench', RuntimeAction> {
  return {
    info: {
      title: 'The PRoot binary in use, its version, and a smoke test against the base rootfs',
      mutating: false,
      run: async (_input, host) => ({
        which:           probe(host, 'which proot'),
        version:         probe(host, 'proot --version 2>&1 | head -3'),
        aptVersion:      probe(host, 'dpkg-query -W -f="${Version}" proot 2>/dev/null'),
        smoke_default:   probe(host, `proot --rootfs=${baseRootfs} /bin/true 2>&1; echo rc=$?`),
        smoke_kernel44:  probe(host, `proot --kernel-release=4.4.0 --rootfs=${baseRootfs} /bin/true 2>&1; echo rc=$?`),
        has_newer_local: probe(host, 'if [ -e /usr/local/bin/proot ]; then /usr/local/bin/proot --version 2>&1 | head -3; else echo "not present"; fi'),
      }),
    },
    inspectRootfs: {
      title: 'The base rootfs: size and a sample of what it holds',
      mutating: false,
      run: async (_input, host) => ({
        baseRootfs,
        duMiB: probe(host, `du -sm ${baseRootfs} 2>/dev/null`, 10_000),
        libDirSize: probe(host, `du -sh ${baseRootfs}/usr/lib/x86_64-linux-gnu 2>/dev/null`, 10_000),
        libCount: probe(host, `ls ${baseRootfs}/usr/lib/x86_64-linux-gnu 2>/dev/null | wc -l`, 10_000),
        bashrc: probe(host, `head -20 ${baseRootfs}/root/.bashrc 2>/dev/null`, 10_000),
        auraDir: probe(host, `ls -la ${baseRootfs}/aura 2>/dev/null`, 10_000),
        bash_v: probe(host, `${baseRootfs}/usr/bin/bash --version 2>&1 | head -1`, 10_000),
        htop_check: probe(host, `ldd ${baseRootfs}/usr/bin/htop 2>&1 | grep -i 'not found\\|=>' | head -10`, 10_000),
        basics_present: probe(host, `for f in ssh sshd nano htop lsof nslookup curl less ip dig; do
        for d in /usr/bin /usr/sbin /bin /sbin; do
          if [ -x "${baseRootfs}$d/$f" ]; then echo "$f $d/$f"; break; fi
        done
      done`, 10_000),
        runningInstancesCount: probe(host, 'ps -ef | grep -E "proot|astro" | grep -v grep | wc -l', 10_000),
        auraToolsRuntime: probe(host, 'du -sh /data/aura/runtime/ 2>/dev/null', 10_000),
      }),
    },
    bench: {
      title: 'Cold-start cost of the PRoot layer (exec /bin/true), no app',
      mutating: false,
      run: async (input, host) => {
        const iterations = typeof input['iterations'] === 'number' ? Math.min(100, Math.max(1, input['iterations'])) : 30;
        return {
          proot_no_binds: timeMs(host, `proot --rootfs=${baseRootfs} /bin/true`, iterations),
          // What the AppManager invokes per app spawn, roughly (workspace + data + /aura/all-tools etc.).
          proot_aura_binds: timeMs(host, `proot --rootfs=${baseRootfs} \
      --bind=/workspace:/workspace \
      --bind=/proc --bind=/dev --bind=/tmp \
      --bind=/etc/resolv.conf:/etc/resolv.conf \
      --bind=/usr/local/bin/node:/usr/local/bin/node \
      --bind=/os/toolchain/bin:/aura/all-tools \
      /bin/true`, iterations),
        };
      },
    },
  };
}
