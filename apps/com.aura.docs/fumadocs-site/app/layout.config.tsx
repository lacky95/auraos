import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <span className="font-bold">Aura Docs</span>
      </>
    ),
  },
  // Top-nav surfaces the major sections. The sidebar inside /docs/* still
  // lists every page; these are just shortcuts on the home nav bar.
  links: [
    { text: 'Introduction', url: '/docs/introduction',    active: 'url' },
    { text: 'Install',      url: '/docs/installation',    active: 'url' },
    { text: 'Quick Start',  url: '/docs/quick-start',     active: 'url' },
    { text: 'Develop',      url: '/docs/develop-an-app',  active: 'nested-url' },
    { text: 'Concepts',     url: '/docs/core-concepts',   active: 'url' },
  ],
};
