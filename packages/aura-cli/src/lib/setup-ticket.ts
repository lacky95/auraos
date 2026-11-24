/**
 * One-time owner setup and password-reset codes. A host command only: the
 * ticket is a file in the master container and no HTTP endpoint mints one.
 */
// The file-only entry: the package root would bundle Valkey and the server runtime.
import { createSetupTicket } from '@aura/core/setup-tickets';
import { inSandbox } from './identity.js';

export type SetupTicketInput = { purpose: 'setup' | 'reset'; username?: string };
export type CreateSetupTicket = (
  dataDir: string,
  input: SetupTicketInput,
) => { code: string; expiresAt: number } | Promise<{ code: string; expiresAt: number }>;

export class SetupCodeRefused extends Error {}

export async function issueSetupCode(
  input: SetupTicketInput,
  create: CreateSetupTicket = createSetupTicket,
): Promise<{ code: string; expiresAt: number }> {
  if (inSandbox()) {
    throw new SetupCodeRefused('this is a host command. Run it from the host: docker exec -it aura-shell aura <command>');
  }
  return create(process.env['AURA_DATA_DIR'] ?? '/data', input);
}
