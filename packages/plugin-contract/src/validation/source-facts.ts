import { createRequire } from 'node:module';
import type { PluginSourceFact, PluginSourceFactsReadInput, PluginNativeContext } from '../generated/contract.generated.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
const ajv = new Ajv({ strict: false, allErrors: true });
const fact = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginSourceFact' });
const input = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginSourceFactsReadInput' });
const context = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/PluginNativeContext' });

// Mirrors the Host protocol data boundary. Inspect descriptors before validators read any values.
function plainData(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'));
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor?.enumerable === true && 'value' in descriptor && plainData(descriptor.value, depth + 1);
  });
}
export function assertPluginSourceFact(value: unknown): asserts value is PluginSourceFact {
  if (!plainData(value) || !fact(value)) throw new TypeError('Invalid PluginSourceFact');
}
export function assertPluginNativeContext(value: unknown): asserts value is PluginNativeContext {
  // Host wraps an already-snapshotted source fact; the identity wrapper does not consume its depth budget.
  if (!plainData(value, -1) || !context(value)) throw new TypeError('Invalid PluginNativeContext');
}
export function assertPluginSourceFactsReadInput(value: unknown): asserts value is PluginSourceFactsReadInput {
  if (!plainData(value) || !input(value)) throw new TypeError('Invalid PluginSourceFactsReadInput');
  const ref = (value as PluginSourceFactsReadInput).messageRef;
  if ([...ref].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError('Invalid PluginSourceFactsReadInput');
  }
}
