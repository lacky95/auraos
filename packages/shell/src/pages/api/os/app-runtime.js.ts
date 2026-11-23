import type { APIRoute } from 'astro';
import { getAppManager, keymapRegistry, resolveProxyConfig, ThemeManager } from '@aura/core';
import { gatewayClaimOf } from '../../../../server/gateway-identity.mjs';
import { gatewayInstance } from '../../../lib/access/identify.ts';
import { readShellKeymapState, readShellThemeSelection, resolveBindings } from '../../../lib/appDocumentState.js';
import { buildAppRuntimeJs } from '../../../lib/appRuntime.js';
import { errorResponse } from '../../../lib/appResponse.js';
import { withEtag } from '../../../lib/etag.js';

/**
 * The body of `/_aura/runtime.js` (server/app-gateway.mjs). Only a signed
 * gateway claim can ask, because the script is built for that claim's instance.
 */
export const GET: APIRoute = async ({ request }) => {
  const mgr = getAppManager();
  const inst = gatewayInstance(request, mgr);
  const claim = gatewayClaimOf(request);
  if (!inst || inst === 'invalid' || !claim) return errorResponse('gateway identity required', 403);
  const manifest = mgr.getManifest(inst.appId);
  if (!manifest) return errorResponse('app not found', 404);

  const sel = await readShellThemeSelection().catch(() => null);
  const themeIdDark = sel?.themeIdDark ?? ThemeManager.DEFAULT_THEME_ID_DARK;
  const themeIdLight = sel?.themeIdLight ?? ThemeManager.DEFAULT_THEME_ID_LIGHT;
  const colorMode = sel?.colorMode ?? ThemeManager.DEFAULT_COLOR_MODE;
  const { theme, resolvedMode } = ThemeManager.resolveActiveTheme(themeIdLight, themeIdDark, colorMode);
  const state = await readShellKeymapState();
  const actions = keymapRegistry.list().filter((a) => a.id.startsWith(`app.${inst.appId}.`) || a.scope !== 'app');

  const js = buildAppRuntimeJs({
    appId: inst.appId,
    instanceId: inst.instanceId,
    label: claim.label,
    slot: claim.slot,
    cfg: resolveProxyConfig(manifest),
    themeStrategy: (manifest.themeStrategy ?? 'inherit') as 'inherit' | 'themed' | 'override',
    framework: theme.framework,
    theme: { themeId: theme.id, themeIdDark, themeIdLight, colorMode, resolvedMode },
    keymap: { actions: [...actions], bindings: resolveBindings(actions, inst.appId, state) },
  });
  return withEtag(request, js, 'text/javascript; charset=utf-8');
};
