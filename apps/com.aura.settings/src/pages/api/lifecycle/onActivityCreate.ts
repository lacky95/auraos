import { createActivityCreateHandler } from '@aura/app-sdk';

/**
 * Activity dispatcher. The launcher / Process Manager / other apps can pass
 * `data: { section: 'theme' | 'general' | 'about' }` to land on a specific
 * settings panel. Without it, you get the main overview.
 */
export const POST = createActivityCreateHandler(({ data }) => {
  const section = (data as { section?: string } | undefined)?.section;
  switch (section) {
    case 'theme':      return { path: '/theme',      title: 'Settings · Theme' };
    case 'workspaces': return { path: '/workspaces', title: 'Settings · Workspaces' };
    case 'keyboard':   return { path: '/keyboard',   title: 'Settings · Keyboard' };
    case 'general':    return { path: '/general',    title: 'Settings · General' };
    case 'about':      return { path: '/about',      title: 'Settings · About' };
    default:           return { path: '/',           title: 'Settings' };
  }
});
