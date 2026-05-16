import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('id') ?? 'com.aura.counter-1';
  const mgr = getAppManager();
  const inst = mgr.getInstance(id);
  const up = mgr.getUpstreamUrl?.(id);
  let probe: { status: number | null; body: string | null; err: string | null } = { status: null, body: null, err: null };
  if (up) {
    try {
      const t0 = Date.now();
      const res = await fetch(`http://${up.host}:${up.port}/api/lifecycle/health`);
      probe = { status: res.status, body: (await res.text()).slice(0, 200), err: null };
      void t0;
    } catch (e) {
      probe.err = (e as Error).message;
    }
  }
  return new Response(JSON.stringify({
    id,
    instance: inst ? {
      instanceId: inst.instanceId,
      appId: inst.appId,
      port: inst.port,
      state: inst.state,
      sandbox: inst.sandbox,
    } : null,
    upstreamUrl: up,
    directProbe: probe,
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
