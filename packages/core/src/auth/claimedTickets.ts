/**
 * Proof that a ticket came from a successful `FileSetupTickets.claim()`.
 * Internal: deliberately not exported from the auth index, so code outside
 * auth can't mark an object it built itself as claimed.
 */
const claimed = new WeakSet<object>();

export function markClaimedTicket(ticket: object): void {
  claimed.add(ticket);
}

export function isClaimedTicket(ticket: unknown): boolean {
  return typeof ticket === 'object' && ticket !== null && claimed.has(ticket);
}

/** True for the one caller that spends this claim. */
export function consumeClaimedTicket(ticket: object): boolean {
  return claimed.delete(ticket);
}
