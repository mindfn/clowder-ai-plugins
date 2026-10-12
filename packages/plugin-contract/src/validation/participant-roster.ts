import { createRequire } from 'node:module';
import type { PluginParticipant, PluginParticipantRosterInput } from '../generated/contract.generated.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
const ajv = new Ajv({ strict: false, allErrors: true });
const participant = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginParticipant' });
const input = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginParticipantRosterInput' });

/** Public shape only; provider support, caller authority and declaration admission remain Host-owned. */
export function assertPluginParticipant(value: unknown): asserts value is PluginParticipant {
  if (!participant(value)) throw new TypeError('Invalid PluginParticipant');
}
export function assertPluginParticipantRosterInput(value: unknown): asserts value is PluginParticipantRosterInput {
  if (!input(value)) throw new TypeError('Invalid PluginParticipantRosterInput');
  const id = (value as PluginParticipantRosterInput).contributionId;
  if (!id.length || id.length > 256 || id.trim() !== id) throw new TypeError('Invalid PluginParticipantRosterInput');
}
