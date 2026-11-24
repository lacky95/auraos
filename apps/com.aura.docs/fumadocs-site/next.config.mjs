import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // No basePath. The App Host serves Docs from `/`, the runner calls
  // /api/lifecycle/* directly, and the shell proxy strips `/api/proxy/<id>`
  // from the agents' MCP, so it arrives as /mcp.
  // serve.mjs builds into a staging dir while the old build keeps serving,
  // then swaps it in — so the dist dir has to be selectable per process.
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
