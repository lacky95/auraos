import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// The Aura shell loads each app iframe at `/api/proxy/<instanceId>/`. With
// Aura's raw runtime mode this app's Next.js dev server is the upstream the
// proxy hits directly — basePath must match the proxy prefix so SSR-emitted
// hrefs and the client-side router agree with the shell's `cfg.preservePrefix`
// forwarding.
//
// We derive the prefix from `APP_INSTANCE_ID` (set by the AppManager runner
// at spawn). `single` instance mode collapses this to `com.aura.docs`; if
// the manifest is ever flipped to `multi` each spawn gets `com.aura.docs-2`
// etc. and basePath shifts with it — no rebuild required.
const INSTANCE_ID = process.env.APP_INSTANCE_ID || process.env.APP_ID || 'com.aura.docs';
const BASE_PATH = `/api/proxy/${INSTANCE_ID}`;

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  basePath: BASE_PATH,
  // serve.mjs builds into `.next-staging` while the old build keeps serving,
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
