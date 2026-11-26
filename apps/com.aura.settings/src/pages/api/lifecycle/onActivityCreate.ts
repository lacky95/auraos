import { createActivityCreateHandler } from '@aura/app-sdk';

/**
 * Activity dispatcher. The launcher / Process Manager / other apps can pass
 * `data: { section }` to land on a specific settings panel, with the same
 * names as the overview's tiles (index.astro `pathForSection`). Without it,
 * you get the main overview.
 */
export const POST = createActivityCreateHandler(({ data }) => {
  const section = (data as { section?: string } | undefined)?.section;
  switch (section) {
    case 'theme':      return { path: '/theme',      title: 'Settings · Theme' };
    case 'workspaces': return { path: '/workspaces', title: 'Settings · Workspaces' };
    case 'layouts':    return { path: '/layouts',    title: 'Settings · Layout Managers' };
    case 'keyboard':   return { path: '/keyboard',   title: 'Settings · Keyboard' };
    case 'general':    return { path: '/general',    title: 'Settings · General' };
    case 'lockscreen': return { path: '/lockscreen', title: 'Settings · Lock Screen' };
    case 'apps':       return { path: '/apps',       title: 'Settings · Apps' };
    case 'access':     return { path: '/access',     title: 'Settings · Notifications & access' };
    case 'users':      return { path: '/users',      title: 'Settings · Users & Identities' };
    case 'runtimes':   return { path: '/runtimes',   title: 'Settings · Runtimes' };
    case 'system':     return { path: '/system',     title: 'Settings · System' };
    case 'about':      return { path: '/about',      title: 'Settings · About' };
    default:           return { path: '/',           title: 'Settings' };
  }
});
