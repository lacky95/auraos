/**
 * One-time owner setup and password-reset codes. A host command only: the
 * ticket is a file in the master container and no HTTP endpoint mints one.
 */
import { inSandbox } from './identity.js';

export type SetupTicketInput = { purpose: 'setup' | 'reset'; username?: string };
export type CreateSetupTicket = (
  dataDir: string,
  input: SetupTicketInput,
) => { code: string; expiresAt: number } | Promise<{ code: string; expiresAt: number }>;

// INTEGRATION: when stream A lands, replace this line with
//   import { createSetupTicket } from '@aura/core';
// and use it as the default below.
const wiredCreateSetupTicket: CreateSetupTicket | null = null;

export class SetupCodeRefused extends Error {}

export async function issueSetupCode(
  input: SetupTicketInput,
  create: CreateSetupTicket | null = wiredCreateSetupTicket,
): Promise<{ code: string; expiresAt: number }> {
  if (process.env['AURA_OWNER_LOGIN'] !== 'on') {
    throw new SetupCodeRefused('owner login is not active on this system (AURA_OWNER_LOGIN is not on).');
  }
  if (inSandbox()) {
    throw new SetupCodeRefused('this is a host command. Run it from the host: docker exec -it aura-shell aura <command>');
  }
  if (!create) throw new SetupCodeRefused('this build has no setup ticket support yet.');
  return create(process.env['AURA_DATA_DIR'] ?? '/data', input);
}
