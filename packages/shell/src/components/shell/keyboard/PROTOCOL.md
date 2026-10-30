# Virtual keyboard input protocol

AuraOS owns the keyboard; Activities receive the input. The shell's virtual
keyboard never touches an app's DOM directly. It posts messages, and a small
receiver turns them into events inside the app.

## Shell → app: `aura.key.synthetic`

Posted by `AuraInputManager` (`lib/keyboard/AuraInputManager.ts`) to the
target app's window (or to the shell window itself for shell fields).

```ts
{
  type: 'aura.key.synthetic',
  action: 'keydown' | 'keyup' | 'text',
  key?: string,      // KeyboardEvent.key  ("a", "A", "Enter", "ArrowLeft", " ")
  code?: string,     // KeyboardEvent.code ("KeyA", "Enter"); US physical position
  keyCode?: number,  // legacy keyCode (xterm.js, Guacamole read it)
  text?: string,     // action 'text' only: insert this string
  repeat: boolean,   // held key auto-repeat
  ctrl: boolean, alt: boolean, shift: boolean, meta: boolean,
}
```

A tap is `keydown` on press and `keyup` on release; a held key repeats
`keydown` with `repeat: true`. Sticky modifiers send their own
`keydown`/`keyup` (`Control`, `Alt`, `Shift`, `Meta`) around the keys they
modify, so apps that track modifier keys (Guacamole) stay in sync.

### Receiver

`lib/keyboard/receiverScript.ts` — injected by the proxy into every app
document when `injectKeyForwarder` is on (the default), and into the shell
page by `KeyboardOverlay.astro`.

- Accepts messages only from `window.parent` (the shell). Apps cannot inject
  keys into the shell or into each other.
- Dispatches `keydown` / `keypress` / `keyup` on the deepest
  `document.activeElement` (through open shadow roots).
- Synthetic events have `isTrusted === false`, so the browser does no editing.
  When the app did not `preventDefault()` the `keydown`, the receiver edits
  plain `<input>`, `<textarea>` and `contenteditable` elements itself:
  inserts text (`beforeinput` → `setRangeText` / `execCommand('insertText')`
  → `input`), Backspace/Delete, caret moves (arrows, Home/End, Shift to
  select), Enter (newline, or implicit form submit), Ctrl+A.
- xterm.js (`.xterm-helper-textarea`) gets only key events: it turns
  `keydown`/`keypress` into terminal data itself.

### Limits

- Privileged browser actions don't run from synthetic events: clipboard
  (`Ctrl+C/V/X` copy/paste in plain fields), browser shortcuts, IME.
- `code` is the US physical position, so code-based shortcuts follow US
  positions even when the QWERTZ layout is shown.
- An app that turns off `injectKeyForwarder` has no receiver; it must listen
  for `aura.key.synthetic` itself (same payload).
- OS shortcuts work: a synthetic `keydown` inside an app passes through that
  app's key forwarder, so OS-claimed combos (e.g. `Ctrl+Alt+L`) reach the
  shell dispatcher like real ones.

## App → shell: asking for the keyboard

An app can post to `window.parent`:

```ts
{ type: 'aura.keyboard.open', attach?: boolean, layout?: string }
{ type: 'aura.keyboard.close' }
```

`attach: true` opens the keyboard attached to the sender's own window and
pins input to it. `layout` is one of the built-in ids (`full`, `qwerty`,
`compact`, `navigation`, `shortcuts`, `terminal`, `editor`, `remote`).

## Agents (shell MCP UI commands)

- `openKeyboard { layout?, mode?: 'docked'|'floating', dockBehavior?: 'push'|'overlay' }`
- `closeKeyboard`
- `sendKey { key, ctrl?, alt?, shift?, meta? }` or `sendKey { text }`
- snapshot part `keyboard`: open state, mode, layout, current target.

## State (OS KV `os/virtual-keyboard/*`)

`mode`, `layout`, `dockBehavior`, `floatRect`, `attachedViewId`, `autoFit`,
and an optional user `customLayout` (`{ default: string[], shift?: string[] }`
in simple-keyboard format). The open flag is not stored: the keyboard
starts closed on every load.
