import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();
const ROOT = new URL('../../..', import.meta.url).pathname;

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // No basePath. The App Host serves Docs from `/`, the runner calls
  // /api/lifecycle/* directly, and the shell proxy strips `/api/proxy/<id>`
  // from the agents' MCP, so it arrives as /mcp.
  // serve.mjs builds into a staging dir while the old build keeps serving,
  // then swaps it in — so the dist dir has to be selectable per process.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Production builds type-check; `next dev` never did. Serve what
  // compiles — same behaviour dev mode had. (Next 16 has no lint step.)
  typescript: { ignoreBuildErrors: true },
  // The monorepo is the root: pnpm links next, fumadocs and @aura/app-sdk
  // from /workspace/node_modules, and Turbopack (Next 16's default bundler)
  // compiles nothing outside its root.
  outputFileTracingRoot: ROOT,
  turbopack: { root: ROOT },
};

export default withMDX(config);
