/**
 * @aura/ui — AuraOS canonical component library.
 *
 * Built on scificn (https://www.scificn.dev) — Radix-based React primitives,
 * Tailwind 4 styling, shadcn-style registry distribution. Apps depend on
 * `@aura/ui` to get OS-themed UI; the theme bridge in
 * `./styles/scificn-bridge.css` maps scificn tokens onto `--aura-color-*`
 * so components inherit live theming.
 *
 * Consumers import the bridge CSS via Astro frontmatter (JS import), NOT
 * via CSS @import — postcss-import doesn't honour Vite's array aliases and
 * would fail on `<index.ts>/styles/scificn-bridge.css`:
 *
 *   ---
 *   import '@aura/ui/styles/scificn-bridge.css';
 *   import '../styles/global.css';
 *   ---
 *
 * And add `react()` + `@tailwindcss/vite()` to `astro.config.mjs`. Each
 * consumer also needs `react`, `react-dom`, `@astrojs/react`,
 * `@tailwindcss/vite`, `tailwindcss` in its own `package.json` (peer-style;
 * @aura/ui doesn't ship them).
 */

export { Button,   buttonVariants } from './components/ui/button/button.js';
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogBody,
} from './components/ui/dialog/dialog.js';
export { Checkbox } from './components/ui/checkbox/checkbox.js';
export { Spinner }  from './components/ui/spinner/spinner.js';
export { Tabs, TabsGroup, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs/tabs.js';

export { Badge, badgeVariants } from './components/ui/badge/badge.js';
export type { BadgeProps }       from './components/ui/badge/badge.js';
export { Input }                 from './components/ui/input/input.js';
export type { InputProps }       from './components/ui/input/input.js';
export { Label }                 from './components/ui/label/label.js';
export { Panel, PanelHeader, PanelTitle, PanelContent, PanelFooter } from './components/ui/panel/panel.js';
export type { PanelProps }       from './components/ui/panel/panel.js';
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from './components/ui/select/select.js';

export { cn } from './lib/utils.js';
