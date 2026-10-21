/**
 * Browser-safe configuration-variant resolution (configurationVariants,
 * contractVersion 0.2.0).
 *
 * This module is intentionally free of any `node:` or ajv import so the same
 * code runs in the browser (settings form) and on the server (save/readiness/
 * runtime projection). Value matching is strict `===` against `const`/`enum`
 * declared in each branch's constrained `when` fragment.
 *
 * @packageDocumentation
 */

import type { ConfigurationField, PluginManifest } from './generated/contract.generated.js';

export type VariantResolution =
  | { readonly status: 'selected'; readonly branchId: string }
  | { readonly status: 'unselected' }
  | { readonly status: 'invalid'; readonly value: unknown };

export interface EffectiveConfiguration {
  readonly resolution: VariantResolution;
  readonly effectiveValues: Record<string, unknown>;
}

type VariantBranch = NonNullable<PluginManifest['configurationVariants']>['branches'][number];

type StoredValues = Readonly<Record<string, unknown>>;

function matchesConstraint(constraint: unknown, value: unknown): boolean {
  if (typeof constraint !== 'object' || constraint === null) return false;
  const candidate = constraint as Record<string, unknown>;
  if ('const' in candidate) return value === candidate['const'];
  if ('enum' in candidate && Array.isArray(candidate['enum'])) {
    return candidate['enum'].some((option) => option === value);
  }
  return false;
}

function branchMatches(branch: VariantBranch, discriminator: string, value: unknown): boolean {
  const properties = branch.when['properties'];
  if (typeof properties !== 'object' || properties === null) return false;
  return matchesConstraint((properties as Record<string, unknown>)[discriminator], value);
}

function fieldDefault(field: ConfigurationField): unknown {
  return 'default' in field ? field.default : undefined;
}

function effectiveFieldValue(
  field: ConfigurationField,
  storedValues: StoredValues,
): unknown {
  const stored = storedValues[field.key];
  return stored === undefined ? fieldDefault(field) : stored;
}

/**
 * Three-state variant resolution for a stored (or drafted) configuration.
 *
 * - `unselected`: no discriminator value present — neither stored nor declared
 *   as the discriminator field's `default` (or the manifest declares no
 *   variants, preserving pre-0.2.0 behavior).
 * - `invalid`: a discriminator value is present (stored, or a declared default)
 *   but no branch `when` matches.
 * - `selected`: exactly one branch matches; the first match wins if a
 *   non-conformant manifest makes branches overlap.
 */
export function resolveConfigurationVariant(
  manifest: PluginManifest,
  values: StoredValues,
): VariantResolution {
  const variants = manifest.configurationVariants;
  if (variants === undefined) return { status: 'unselected' };

  let value = values[variants.discriminator];
  if (value === undefined) {
    const discriminatorField = (manifest.configuration ?? []).find(
      (field) => field.key === variants.discriminator,
    );
    value = discriminatorField === undefined ? undefined : fieldDefault(discriminatorField);
  }
  if (value === undefined) return { status: 'unselected' };

  for (const branch of variants.branches) {
    if (branchMatches(branch, variants.discriminator, value)) {
      return { status: 'selected', branchId: branch.id };
    }
  }
  return { status: 'invalid', value };
}

/**
 * Computes the effective configuration: common fields (not claimed by any
 * branch) plus, when a branch is selected, that branch's fields. Missing
 * stored values fall back to the declared field default — consumers never
 * depend on save-time materialization. On `unselected`/`invalid` only common
 * fields are returned; an invalid discriminator value is kept as stored (no
 * silent fallback to the declared default).
 */
export function computeEffectiveConfiguration(
  manifest: PluginManifest,
  storedValues: StoredValues,
): EffectiveConfiguration {
  const configuration = manifest.configuration ?? [];
  const variants = manifest.configurationVariants;
  const resolution = resolveConfigurationVariant(manifest, storedValues);

  const branchFieldKeys = new Set<string>();
  if (variants !== undefined) {
    for (const branch of variants.branches) {
      for (const key of branch.fields) branchFieldKeys.add(key);
    }
  }

  const activeBranch =
    resolution.status === 'selected' && variants !== undefined
      ? variants.branches.find((branch) => branch.id === resolution.branchId)
      : undefined;
  const activeKeys = new Set(activeBranch?.fields ?? []);

  const effectiveValues: Record<string, unknown> = {};
  for (const field of configuration) {
    const isBranchField = branchFieldKeys.has(field.key);
    const isActive = activeKeys.has(field.key);
    if (isBranchField && !isActive) continue;

    if (
      resolution.status === 'invalid' &&
      variants !== undefined &&
      field.key === variants.discriminator
    ) {
      effectiveValues[field.key] = storedValues[field.key];
      continue;
    }
    effectiveValues[field.key] = effectiveFieldValue(field, storedValues);
  }

  return { resolution, effectiveValues };
}

/**
 * The single source of truth for whether a field is required, given an
 * effective (or drafted) configuration object.
 *
 * When `requiredWhen` is present it fully replaces the `required` flag: the
 * field is required iff the referenced field's current value strictly
 * (`===`, no stringification) equals one of the declared conditions. When
 * `requiredWhen` is absent, the plain `required` flag decides. Branch
 * membership never influences requiredness — it only decides whether a field
 * is active at all.
 */
export function evaluateFieldRequiredness(
  field: ConfigurationField,
  values: StoredValues,
): boolean {
  const requiredWhen = field.requiredWhen;
  if (requiredWhen === undefined) return field.required === true;
  const conditions = Array.isArray(requiredWhen.value)
    ? requiredWhen.value
    : [requiredWhen.value];
  const actual = values[requiredWhen.key];
  return conditions.some((condition) => condition === actual);
}

function fieldValueConstraint(field: ConfigurationField): Record<string, unknown> {
  switch (field.kind) {
    case 'string':
    case 'secret':
    case 'url':
      return { type: 'string', minLength: 1 };
    case 'select':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return {};
  }
}

function conditionalRequirement(
  field: ConfigurationField,
): Record<string, unknown> | undefined {
  const requiredWhen = field.requiredWhen;
  if (requiredWhen === undefined) return undefined;
  const conditions = Array.isArray(requiredWhen.value)
    ? requiredWhen.value
    : [requiredWhen.value];
  const constraint = fieldValueConstraint(field);
  return {
    if: {
      properties: { [requiredWhen.key]: { enum: conditions } },
      required: [requiredWhen.key],
    },
    then: {
      required: [field.key],
      ...(Object.keys(constraint).length > 0 ? { properties: { [field.key]: constraint } } : {}),
    },
  };
}

/**
 * Compiles the manifest into a standard JSON Schema for validating the
 * *effective* configuration object (see {@link computeEffectiveConfiguration}),
 * not the raw stored object.
 *
 * - Common fields (not claimed by any branch) are constrained at the top
 *   level: unconditionally required fields land in `required` and get a kind
 *   constraint (e.g. `{type:'string', minLength:1}` for string-likes, so a
 *   present `null` or empty string does not count as configured);
 *   `requiredWhen` fields become top-level `if/then` clauses keyed on the
 *   referenced field's runtime value.
 * - Each branch compiles to one `oneOf` member containing the cloned `when`
 *   fragment, the discriminator in `required`, and its active fields handled
 *   the same way (static `required` for plain `required: true`, `if/then` for
 *   `requiredWhen`). A field that is `requiredWhen`-gated against the
 *   discriminator therefore stays optional in a member whose discriminator
 *   values do not satisfy the condition — enum branches covering several
 *   options keep working without merging values.
 *
 * Requiredness semantics are exactly {@link evaluateFieldRequiredness}; this
 * schema is the ajv-executable form of that function plus kind constraints.
 */
export function buildVariantValidationSchema(
  manifest: PluginManifest,
): Record<string, unknown> {
  const variants = manifest.configurationVariants;
  const configuration = manifest.configuration ?? [];
  const configByKey = new Map<string, ConfigurationField>();
  for (const field of configuration) configByKey.set(field.key, field);

  const branchFieldKeys = new Set<string>();
  for (const branch of variants?.branches ?? []) {
    for (const key of branch.fields) branchFieldKeys.add(key);
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const commonConditionals: Record<string, unknown>[] = [];
  for (const field of configuration) {
    if (branchFieldKeys.has(field.key)) continue;
    const constraint = fieldValueConstraint(field);
    if (Object.keys(constraint).length > 0) properties[field.key] = constraint;
    const conditional = conditionalRequirement(field);
    if (conditional !== undefined) {
      commonConditionals.push(conditional);
    } else if (field.required === true) {
      required.push(field.key);
    }
  }

  const oneOf = (variants?.branches ?? []).map((branch) => {
    const memberProperties: Record<string, unknown> = structuredClone(
      (branch.when['properties'] ?? {}) as Record<string, unknown>,
    );
    const memberRequired: string[] = [variants!.discriminator];
    const memberConditionals: Record<string, unknown>[] = [];

    for (const key of branch.fields) {
      const field = configByKey.get(key);
      if (field === undefined) continue;
      const constraint = fieldValueConstraint(field);
      if (Object.keys(constraint).length > 0) memberProperties[key] = constraint;
      const conditional = conditionalRequirement(field);
      if (conditional !== undefined) {
        memberConditionals.push(conditional);
      } else if (field.required === true) {
        memberRequired.push(key);
      }
    }

    return {
      properties: memberProperties,
      required: memberRequired,
      ...(memberConditionals.length > 0 ? { allOf: memberConditionals } : {}),
    };
  });

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(commonConditionals.length > 0 ? { allOf: commonConditionals } : {}),
    ...(oneOf.length > 0 ? { oneOf } : {}),
  };
}
