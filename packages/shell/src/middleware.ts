import { defineMiddleware } from 'astro:middleware';
import { getAppManager, initAppManager } from '@aura/core';

let initialized = false;

async function ensureAppManager() {
  if (initialized) return;
  initialized = true;

  const mgr = initAppManager({
    appsDir:      process.env['AURA_APPS_DIR']      ?? '/workspace/apps',
    dataDir:      process.env['AURA_DATA_DIR']      ?? '/data',
    baseRootfs:   process.env['AURA_BASE_ROOTFS']   ?? '/os/base-rootfs',
    toolchainDir: process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain',
    portStart:    Number(process.env['AURA_APP_PORT_START'] ?? 4001),
    portEnd:      Number(process.env['AURA_APP_PORT_END']   ?? 4999),
    shellPort:    Number(process.env['AURA_SHELL_PORT']     ?? 3000),
  });

  await mgr.init();
}

export const onRequest = defineMiddleware(async (_ctx, next) => {
  await ensureAppManager();
  return next();
});
