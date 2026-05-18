/**
 * Keymap data model — input-source agnostic (keyboard today, controller later).
 * Action ids are the stable string apps + the OS dispatch against; bindings are
 * the actual key combos. Manifest declarations + runtime overlays both feed the
 * KeymapRegistry; the Settings UI edits the user overlay stored at KV
 * `os/keymap`.
 *
 * Scope precedence (resolved by KeyDispatcher):
 *   os-always  >  os-modifier  >  os-nav (in 'nav' mode) | app (forwarded from focused app)
 *
 * A canonical combo string sorts modifiers as Ctrl→Alt→Shift→Super and ends
 * with the non-modifier key as `KeyboardEvent.code` (physical position, so
 * Dvorak/Colemak/AZERTY remap survives without rebinding).
 * Examples: "Ctrl+Alt+KeyM", "Ctrl+Digit1", "Escape", "KeyJ".
 */

export type KeyScope =
  | 'os-always'    // fires in every mode (Home, OS modifiers)
  | 'os-nav'       // fires only when shell is in Nav mode
  | 'os-modifier'  // fires anywhere; conventionally requires Ctrl+Alt (or equiv)
  | 'app';         // fires only when an app iframe owns focus; forwarded from iframe

export interface KeyAction {
  /** Stable identifier. `aura.*` for OS actions, `app.<appId>.*` for app actions. */
  id:           string;
  /** Tab header in Settings ("Basic Navigation", "Window Management", …). */
  category:     string;
  /** User-visible name. */
  label:        string;
  /** Optional one-liner shown next to the row. */
  description?: string;
  scope:        KeyScope;
  /** Canonical combo string; `null` means unbound by default (user can assign). */
  defaultCombo: string | null;
}

/** Sparse: only entries that differ from the registry's default. `null` = explicitly unbound. */
export interface KeymapBindings { [actionId: string]: string | null }

/**
 * Persisted user keymap. Stored as a single KV value at `os/keymap`.
 *  - `bindings`     — overrides for OS-scope actions (scope ≠ 'app').
 *  - `appOverlays`  — per-app overrides of manifest-declared `app.<appId>.*`.
 */
export interface OsKeymapState {
  bindings:    KeymapBindings;
  appOverlays: { [appId: string]: KeymapBindings };
}

/**
 * Canonical OS action set. Categorised; Phase 3 wires the handlers. The
 * `defaultCombo` strings use `KeyboardEvent.code` for non-modifiers so they
 * are layout-independent.
 *
 * NEVER bind an unmodified printable to an OS action — those keys are the
 * user's text input. Single-key bindings are reserved for `os-nav` scope
 * where text entry is impossible.
 */
export const DEFAULT_OS_ACTIONS: readonly KeyAction[] = [
  // Basic Navigation — single arrows in Nav mode, plus Back/Home/Enter.
  { id: 'aura.nav.up',     category: 'Basic Navigation', label: 'Move focus up',    scope: 'os-nav',    defaultCombo: 'ArrowUp'    },
  { id: 'aura.nav.down',   category: 'Basic Navigation', label: 'Move focus down',  scope: 'os-nav',    defaultCombo: 'ArrowDown'  },
  { id: 'aura.nav.left',   category: 'Basic Navigation', label: 'Move focus left',  scope: 'os-nav',    defaultCombo: 'ArrowLeft'  },
  { id: 'aura.nav.right',  category: 'Basic Navigation', label: 'Move focus right', scope: 'os-nav',    defaultCombo: 'ArrowRight' },
  // Pointer-style navigation primitives:
  //   • Enter            = "left click"  — primary activate.
  //   • RShift+Enter     = "right click" — secondary activate (context menu / alt action).
  //   • RShift+Backspace = "back"         — pop activity / leave focus.
  // Side-specific RShift so the user can still use generic Shift+Enter /
  // Shift+Backspace for app-level shortcuts without colliding.
  { id: 'aura.nav.enter',           category: 'Basic Navigation', label: 'Primary activate (focus selected window)',  scope: 'os-nav',    defaultCombo: 'Enter'              },
  { id: 'aura.nav.enter-secondary', category: 'Basic Navigation', label: 'Secondary activate (context / alt action)', scope: 'os-nav',    defaultCombo: 'RShift+Enter'       },
  { id: 'aura.nav.back',            category: 'Basic Navigation', label: 'Back (to Nav mode / pop activity)',         scope: 'os-always', defaultCombo: 'RShift+Backspace'   },
  { id: 'aura.nav.home',   category: 'Basic Navigation', label: 'Home (force Nav mode)',             scope: 'os-always',   defaultCombo: 'Ctrl+Alt+KeyH' },

  // Window Management
  { id: 'aura.window.focus-next',     category: 'Window Management', label: 'Focus next window',     scope: 'os-modifier', defaultCombo: 'Ctrl+Alt+ArrowRight' },
  { id: 'aura.window.focus-prev',     category: 'Window Management', label: 'Focus previous window', scope: 'os-modifier', defaultCombo: 'Ctrl+Alt+ArrowLeft'  },
  { id: 'aura.window.close',          category: 'Window Management', label: 'Close focused window',  scope: 'os-modifier', defaultCombo: 'Ctrl+Alt+KeyW'       },
  { id: 'aura.window.minimize',       category: 'Window Management', label: 'Minimize focused window', scope: 'os-modifier', defaultCombo: 'Ctrl+Alt+KeyN'     },

  // Workspaces
  { id: 'aura.workspace.switch-1',    category: 'Workspaces', label: 'Switch to workspace 1', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit1' },
  { id: 'aura.workspace.switch-2',    category: 'Workspaces', label: 'Switch to workspace 2', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit2' },
  { id: 'aura.workspace.switch-3',    category: 'Workspaces', label: 'Switch to workspace 3', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit3' },
  { id: 'aura.workspace.switch-4',    category: 'Workspaces', label: 'Switch to workspace 4', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit4' },
  { id: 'aura.workspace.switch-5',    category: 'Workspaces', label: 'Switch to workspace 5', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit5' },
  { id: 'aura.workspace.switch-6',    category: 'Workspaces', label: 'Switch to workspace 6', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit6' },
  { id: 'aura.workspace.switch-7',    category: 'Workspaces', label: 'Switch to workspace 7', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit7' },
  { id: 'aura.workspace.switch-8',    category: 'Workspaces', label: 'Switch to workspace 8', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit8' },
  { id: 'aura.workspace.switch-9',    category: 'Workspaces', label: 'Switch to workspace 9', scope: 'os-modifier', defaultCombo: 'Ctrl+Digit9' },
  { id: 'aura.workspace.new',         category: 'Workspaces', label: 'New workspace',         scope: 'os-modifier', defaultCombo: 'Ctrl+Shift+KeyN' },
  { id: 'aura.workspace.cycle-next',  category: 'Workspaces', label: 'Cycle workspace forward',  scope: 'os-modifier', defaultCombo: 'Ctrl+Tab'        },
  { id: 'aura.workspace.cycle-prev',  category: 'Workspaces', label: 'Cycle workspace backward', scope: 'os-modifier', defaultCombo: 'Ctrl+Shift+Tab'  },

  // Launcher
  { id: 'aura.launcher.toggle',       category: 'Launcher', label: 'Toggle app launcher',  scope: 'os-modifier', defaultCombo: 'Ctrl+Alt+Space' },
  // Alternative combo for the launcher — useful when Ctrl+Alt+Space
  // collides with a window-manager binding (some Linux compositors and
  // accessibility tools claim it). Both actions share the same handler
  // in LauncherOverlay.astro and either combo toggles the panel.
  { id: 'aura.launcher.toggle-alt',   category: 'Launcher', label: 'Toggle app launcher (alt)', scope: 'os-modifier', defaultCombo: 'Ctrl+Alt+KeyC' },
  // NOTE: launcher's own Enter-to-launch lives inside `LauncherOverlay.astro`
  // as a local DOM handler. We DON'T register it as an OS keymap action
  // because that would put Enter in every iframe's claim list and break
  // every terminal / text input that relies on Enter.

  // Process Manager
  { id: 'aura.processmanager.toggle', category: 'Process Manager', label: 'Toggle process manager', scope: 'os-modifier', defaultCombo: 'Ctrl+Alt+KeyM' },

  // Custom user slots — default unbound. The Settings UI lets the user bind
  // a launcher slot to "open <app>" and assign a combo (typically Ctrl+Alt+DigitN).
  { id: 'aura.user.openApp.1', category: 'Custom', label: 'User shortcut 1', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.2', category: 'Custom', label: 'User shortcut 2', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.3', category: 'Custom', label: 'User shortcut 3', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.4', category: 'Custom', label: 'User shortcut 4', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.5', category: 'Custom', label: 'User shortcut 5', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.6', category: 'Custom', label: 'User shortcut 6', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.7', category: 'Custom', label: 'User shortcut 7', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.8', category: 'Custom', label: 'User shortcut 8', scope: 'os-modifier', defaultCombo: null },
  { id: 'aura.user.openApp.9', category: 'Custom', label: 'User shortcut 9', scope: 'os-modifier', defaultCombo: null },
];
