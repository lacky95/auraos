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
};

export default withMDX(config);
