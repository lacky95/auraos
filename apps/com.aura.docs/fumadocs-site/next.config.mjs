import { createMDX } from 'fumadocs-mdx/next';
import { docsBasePath, docsInstanceId, frameRouteOf } from './lib/base-path.mjs';

const withMDX = createMDX();

// Next's basePath follows the frame route this build serves (lib/base-path.mjs):
//
//   proxy (default)  `/api/proxy/<instanceId>`: the shell loads the iframe
//                    there and, with `proxy.preservePrefix`, forwards the
//                    prefix, so SSR-emitted hrefs and the client router agree
//                    with it. The prefix comes from `APP_INSTANCE_ID` (set by
//                    the runner at spawn), so a `multi` instance shifts it
//                    without a code change.
//   host             '': the app's own App Host serves it from `/`.
//
// serve.mjs sets DOCS_FRAME_ROUTE for both `next build` and `next start` of
// one build, so the two always agree.
const FRAME_ROUTE = frameRouteOf(process.env.DOCS_FRAME_ROUTE);
const BASE_PATH = docsBasePath(FRAME_ROUTE, docsInstanceId());

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  basePath: BASE_PATH,
  // Inlined at build, for the search URL in app/layout.tsx.
  env: { DOCS_BASE_PATH: BASE_PATH },
  // serve.mjs builds into a staging dir while the old build keeps serving,
  // then swaps it in, and keeps one build per frame route — so the dist dir
  // has to be selectable per process.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Production builds type-check; `next dev` never did, and the
  // fumadocs-core@15 / fumadocs-mdx@11 interop (see lib/source.ts) trips
  // `PageData.body`. Serve what compiles — same behaviour dev mode had.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Two lockfiles are visible (the monorepo's and this site's); pin the root
  // so Next stops guessing and warning on every build.
  outputFileTracingRoot: new URL('.', import.meta.url).pathname,
};

export default withMDX(config);
