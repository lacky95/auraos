/**
 * Valkey keys the `approvals` module owns (D97 A3, `kv-owner`): approval
 * records (`ValkeyApprovalStore`, Lua compare-and-set, single use). Other
 * modules name an approval only through `approvalRef` (an audit target).
 * A contract leaf.
 */
export const APPROVALS_KV_PREFIXES = ['approval:'] as const;

/** How an approval is named outside the module (audit targets): `approval:<id>`. */
export const approvalRef = (id: string): string => `approval:${id}`;
