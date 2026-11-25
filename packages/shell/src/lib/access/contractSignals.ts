/**
 * Count an app contract signal (types.ts CONTRACT_SIGNALS) in the access
 * report, from a route handler. Never throws and never waits: a report must
 * not change a response. Without the observer (tests, early boot) it is a no-op.
 */
import { ACCESS_BRIDGE_KEY, type AccessBridgeHost, type ContractSignal } from './types.ts';

export function countContractSignal(signal: ContractSignal, appId: string): void {
  try { (globalThis as AccessBridgeHost)[ACCESS_BRIDGE_KEY]?.countContract?.(signal, appId); } catch { /* report only */ }
}
