/**
 * `osClient.system` — trigger OS actions programmatically from inside an
 * app iframe. Each method posts a typed envelope to the shell which routes
 * it to the SAME handlers a keyboard shortcut would fire (launcher toggle,
 * workspace switch, etc.). This is the API surface for in-app buttons like
 * a Cmd-Palette "Open Launcher" or a "Switch workspace" picker.
 *
 * Calls are fire-and-forget — the shell has its own state and the iframe
 * doesn't need an ack for any of these. Use the BroadcastReceiver-style
 * `OsClient.subscribeOsEvents` if you want to observe the side effects.
 */

import type { OsClient } from './OsClient.js';

export class SystemApi {
  constructor(_client: OsClient) { /* no init */ }

  openLauncher():        void { this.post('aura.system.openLauncher'); }
  closeLauncher():       void { this.post('aura.system.closeLauncher'); }
  toggleLauncher():      void { this.post('aura.system.toggleLauncher'); }
  openProcessManager():  void { this.post('aura.system.openProcessManager'); }
  closeProcessManager(): void { this.post('aura.system.closeProcessManager'); }
  toggleProcessManager(): void { this.post('aura.system.toggleProcessManager'); }
  toggleNavMode():       void { this.post('aura.system.toggleNavMode'); }
  /** Go to the OS Home (switch to Nav mode + focus first window). */
  home(): void { this.post('aura.system.toggleHome'); }

  /**
   * Switch to a workspace by its 1-based slot index (matches the `Ctrl+1..9`
   * shortcut numbering). The shell normalises out-of-range indexes.
   */
  switchWorkspace(slot: number): void {
    this.post('aura.system.switchWorkspace', { slot });
  }

  private post(type: string, extras: Record<string, unknown> = {}): void {
    if (typeof window === 'undefined' || window.parent === window) return;
    try { window.parent.postMessage({ type, ...extras }, '*'); }
    catch { /* parent gone */ }
  }
}
