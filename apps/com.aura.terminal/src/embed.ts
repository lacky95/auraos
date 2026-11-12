/**
 * Embed mode — the terminal as a building block for OTHER apps.
 *
 * Any app can host a live terminal session in its own iframe:
 *
 *   /api/proxy/<instanceId>/?embed=1&session=<id>
 *
 * The page then has no chrome of its own (the host draws it), shows exactly
 * the session it was given (claiming it, like a picker switch), and stays out
 * of the OS window business: no `aura.window.label` / `aura.window.rebind`,
 * which would reach the host app rather than the shell.
 *
 * Host contract:
 *   • Get a session: OPEN_TERMINAL intent with `extras.background: true`
 *     (result.sessionId), `POST /api/sessions`, or any id from `GET /api/sessions`.
 *     Close it with `DELETE /api/sessions?id=` when the host is done with it.
 *   • Size: post `{type:'aura.viewport.changed', contentW, contentH}` with the
 *     iframe's box after each layout change — the same single driver the shell
 *     uses for a window. A plain `resize` of the iframe is a fallback.
 *   • Theme / keymap / focus: forward the shell's `aura.theme.changed`,
 *     `aura.mode.changed`, `aura.keymap.changed` and `aura.window.focus`.
 *   • Events to the host: `aura.terminal.ready {session}` (live and ours),
 *     `aura.terminal.locked {session, locked}` (another browser took it, or
 *     gave it back) and `aura.terminal.session-ended {session}` (root `exit`).
 *
 * Inside the shell, `AURA_TERM_SESSION` names the session, so programs running
 * there (e.g. agent hooks) can report which session they belong to.
 *
 * Without `embed=1` nothing here applies and the page behaves as before.
 *
 * Pure, Node builtins only: the tests import this file under --experimental-strip-types.
 */

export interface EmbedParams {
  embed: boolean;
  /** Session to show; only honoured in embed mode. */
  session: string | null;
}

/** A session id as the pty-server names them: `<instanceId>#<label>`. */
const SESSION_RE = /^[^#\s]+#[^#\s]+$/;

export function parseEmbed(search: string): EmbedParams {
  const p = new URLSearchParams(search);
  const embed = p.get('embed') === '1';
  const raw = p.get('session');
  const session = embed && raw && SESSION_RE.test(raw) ? raw : null;
  return { embed, session };
}
