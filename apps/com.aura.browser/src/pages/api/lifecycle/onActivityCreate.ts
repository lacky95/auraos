import { createActivityCreateHandler } from '@aura/app-sdk';

/**
 * Called by the OS when a new activity for this app is opened.
 *
 * Return value (all fields optional):
 *   • `path`       — initial iframe path the activity opens at (default '/')
 *   • `title`      — window-title hint shown in the slot chrome
 *   • `metadata`   — free-form bag the OS keeps with the activity
 *   • `minimizable` — true ONLY for background-service apps; default false
 *   • `breadcrumb` — 'os' (default) shows the OS-managed back trail in the
 *                    slot chrome; 'off' hides it
 *
 * Default impl returns `{}` — activity opens at `/`, the manifest name is
 * used as the title, no breadcrumb override. Customise as the app grows.
 */
export const POST = createActivityCreateHandler(async () => ({}));
