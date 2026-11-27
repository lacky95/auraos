import type { APIRoute } from 'astro';
import { execSync } from 'node:child_process';
import * as core from '@aura/core';
import { actionHost } from '../../../lib/runtimeActions.ts';

/**
 * Micro-benchmark: cold-start overhead of the sandbox layers, doing nothing
 * inside them ("just exec /bin/true"). Pure subsystem cost: no app, no astro
 * boot, no node, no node_modules. The kernel baselines are measured here;
 * every installed runtime with a `bench` action adds its own rows (5b PR:
 * PRoot's), so no runtime-specific command lives in this route.
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

export const GET: APIRoute = async () => {
  const iterations = 30;
  const results: Record<string, unknown> = { iterations };

  // 1. Native: just fork+exec /bin/true. The kernel-only baseline.
  results['native'] = timeNs('/bin/true', iterations);

  // 2. Bash subshell: shell parse + fork + exec. The "what a shell costs" line.
  results['bash_subshell'] = timeNs('bash -c true', iterations);

  // 3. Each runtime's own layer (PRoot: no binds, and AuraOS-shaped binds).
  for (const m of core.getAppManager().runtimes.list()) {
    const bench = m.actions?.['bench'];
    if (bench && !bench.mutating) Object.assign(results, await bench.run({ iterations }, actionHost));
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
