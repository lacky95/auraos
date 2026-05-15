import type { APIRoute } from 'astro';
import { execSync } from 'node:child_process';

/**
 * Micro-benchmark: cold-start overhead of different sandbox layers, doing
 * nothing inside them ("just exec /bin/true"). Pure subsystem cost — no app,
 * no astro boot, no node, no node_modules. The PRoot row is real-machine
 * data from this container; the container row is the best published number
 * for a comparable runc invocation since we can't `docker run` from inside
 * a non-DinD container.
 */
function timeNs(cmd: string, iterations: number): { mean_ms: number; min_ms: number; max_ms: number } {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    try { execSync(cmd, { stdio: 'ignore' }); } catch { /* keep timing on failure */ }
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1_000_000);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min  = Math.min(...samples);
  const max  = Math.max(...samples);
  return { mean_ms: +mean.toFixed(2), min_ms: +min.toFixed(2), max_ms: +max.toFixed(2) };
}

export const GET: APIRoute = () => {
  const iterations = 30;
  const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
  const results: Record<string, unknown> = { iterations };

  // 1. Native: just fork+exec /bin/true. The kernel-only baseline.
  results['native'] = timeNs('/bin/true', iterations);

  // 2. Bash subshell: shell parse + fork + exec. The "what a shell costs" line.
  results['bash_subshell'] = timeNs('bash -c true', iterations);

  // 3. PRoot, no binds: minimum proot setup cost.
  results['proot_no_binds'] = timeNs(`proot --rootfs=${baseRootfs} /bin/true`, iterations);

  // 4. PRoot, AuraOS-shaped binds: what the AppManager actually invokes per
  //    app spawn (workspace + data + /aura/all-tools + /aura/my-tools etc.).
  results['proot_aura_binds'] = timeNs(
    `proot --rootfs=${baseRootfs} \
      --bind=/workspace:/workspace \
      --bind=/proc --bind=/dev --bind=/tmp \
      --bind=/etc/resolv.conf:/etc/resolv.conf \
      --bind=/usr/local/bin/node:/usr/local/bin/node \
      --bind=/os/toolchain/bin:/aura/all-tools \
      /bin/true`,
    iterations,
  );

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
