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

function isStringLike(field: ConfigurationField): boolean {
  return field.kind === 'string' || field.kind === 'secret' || field.kind === 'url';
}

function requiredWhenSatisfiedByBranch(
  field: ConfigurationField,
  branchValues: readonly unknown[],
): boolean {
  if (field.requiredWhen === undefined) return false;
  const conditions = Array.isArray(field.requiredWhen.value)
    ? field.requiredWhen.value
    : [field.requiredWhen.value];
  return conditions.some((condition) => branchValues.some((value) => value === condition));
}

/**
 * Compiles the constrained branch `when` fragments into a standard JSON
 * Schema (`{type:'object', oneOf:[...]}`) for validating the *effective*
 * configuration object (see {@link computeEffectiveConfiguration}), not the
 * raw stored object. Required string-like fields get `minLength: 1` so a
 * present-but-empty value does not count as configured. Fields with
 * `required: false` stay optional; a `requiredWhen` keyed on the
 * discriminator is resolved statically against the branch's own values.
 */
export function buildVariantValidationSchema(
  manifest: PluginManifest,
): Record<string, unknown> {
  const variants = manifest.configurationVariants;
  const configuration = manifest.configuration ?? [];
  const configByKey = new Map<string, ConfigurationField>();
  for (const field of configuration) configByKey.set(field.key, field);

  const oneOf = (variants?.branches ?? []).map((branch) => {
    const discriminatorConstraint = (branch.when['properties'] as Record<string, unknown> | undefined)?.[
      variants!.discriminator
    ];
    const branchValues =
      typeof discriminatorConstraint === 'object' && discriminatorConstraint !== null
        ? 'const' in discriminatorConstraint
          ? [(discriminatorConstraint as Record<string, unknown>)['const']]
          : Array.isArray((discriminatorConstraint as Record<string, unknown>)['enum'])
            ? ((discriminatorConstraint as Record<string, unknown>)['enum'] as unknown[])
            : []
        : [];

    const properties: Record<string, unknown> = structuredClone(
      (branch.when['properties'] ?? {}) as Record<string, unknown>,
    );
    const required: string[] = [variants!.discriminator];

    for (const key of branch.fields) {
      const field = configByKey.get(key);
      if (field === undefined) continue;
      const isRequired =
        field.required === true ||
        requiredWhenSatisfiedByBranch(field, branchValues);
      if (!isRequired) continue;
      required.push(key);
      if (isStringLike(field)) {
        properties[key] = { minLength: 1 };
      }
    }

    return { properties, required };
  });

  return { type: 'object', oneOf };
}
