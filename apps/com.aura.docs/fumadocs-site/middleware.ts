import { NextResponse, type NextRequest } from 'next/server';
import { auraIdentityHeaders } from '@aura/app-sdk/runtime/next';

// Stamp X-Aura-App-Id / X-Aura-Instance-Id on every response so the shell
// proxy's identity gate (`packages/shell/src/pages/api/proxy/[id]/[...path].ts:167`)
// sees a matching pair. Without this the gate would silently pass (headers
// absent → no check), which works until a port gets reused after a crash
// and the proxy would happily route to a squatter.
//
// The matcher is everything (`/(.*)`) so static assets, RSC payloads, and
// API routes all carry identity. Middleware is the right tier because Next
// app-router pages don't run a per-request handler we can hook otherwise.
export function middleware(_req: NextRequest) {
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(auraIdentityHeaders())) {
    res.headers.set(k, v);
  }
  return res;
}

export const config = { matcher: '/(.*)' };
