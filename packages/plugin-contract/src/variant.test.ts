import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { PluginManifest } from './generated/contract.generated.js';
import {
  buildVariantValidationSchema,
  computeEffectiveConfiguration,
  resolveConfigurationVariant,
} from './variant.js';

const feishuLike = {
  pluginId: 'dev.clowder.fixture.variants',
  version: '0.1.0',
  contractVersion: '0.2.0',
  name: 'Variant fixture',
  features: [{ id: 'echo', name: 'Echo', resources: [], capabilities: [] }],
  runtime: { transport: 'builtin' },
  configuration: [
    { key: 'appId', label: 'App ID', kind: 'string', required: true },
    {
      key: 'connectionMode',
      label: 'Mode',
      kind: 'select',
      required: true,
      default: 'webhook',
      options: [
        { value: 'webhook', label: 'Webhook' },
        { value: 'websocket', label: 'Websocket' },
      ],
    },
    { key: 'verificationToken', label: 'Token', kind: 'secret', required: true },
    { key: 'groupBotMentionsJson', label: 'Mentions', kind: 'string', required: false, hidden: true },
  ],
  configurationVariants: {
    discriminator: 'connectionMode',
    branches: [
      {
        id: 'webhook',
        when: { properties: { connectionMode: { const: 'webhook' } } },
        fields: ['verificationToken'],
      },
      {
        id: 'websocket',
        when: { properties: { connectionMode: { const: 'websocket' } } },
        fields: [],
      },
    ],
  },
} as unknown as PluginManifest;

const videoGenLike = {
  ...feishuLike,
  configuration: [
    {
      key: 'authType',
      label: 'Auth',
      kind: 'select',
      required: true,
      options: [
        { value: 'apikey', label: 'API Key' },
        { value: 'jwt-hs256', label: 'JWT' },
        { value: 'hmac-sha256-v4', label: 'HMAC' },
      ],
    },
    { key: 'apiKey', label: 'API Key', kind: 'secret', required: true },
    { key: 'accessKey', label: 'Access Key', kind: 'secret', required: true },
    { key: 'secretKey', label: 'Secret Key', kind: 'secret', required: true },
    { key: 'model', label: 'Model', kind: 'string', required: false },
  ],
  configurationVariants: {
    discriminator: 'authType',
    branches: [
      {
        id: 'apikey',
        when: { properties: { authType: { const: 'apikey' } } },
        fields: ['apiKey'],
      },
      {
        id: 'jwt',
        when: { properties: { authType: { enum: ['jwt-hs256'] } } },
        fields: ['accessKey', 'secretKey'],
      },
      {
        id: 'hmac',
        when: { properties: { authType: { enum: ['hmac-sha256-v4'] } } },
        fields: ['accessKey', 'secretKey'],
      },
    ],
  },
} as unknown as PluginManifest;

test('resolveConfigurationVariant selects the matching branch', () => {
  assert.deepEqual(
    resolveConfigurationVariant(feishuLike, { connectionMode: 'webhook' }),
    { status: 'selected', branchId: 'webhook' },
  );
  assert.deepEqual(
    resolveConfigurationVariant(feishuLike, { connectionMode: 'websocket' }),
    { status: 'selected', branchId: 'websocket' },
  );
});

test('resolveConfigurationVariant matches enum constraints across shared branches', () => {
  assert.deepEqual(
    resolveConfigurationVariant(videoGenLike, { authType: 'jwt-hs256' }),
    { status: 'selected', branchId: 'jwt' },
  );
  assert.deepEqual(
    resolveConfigurationVariant(videoGenLike, { authType: 'hmac-sha256-v4' }),
    { status: 'selected', branchId: 'hmac' },
  );
});

test('resolveConfigurationVariant falls back to the discriminator field default', () => {
  assert.deepEqual(resolveConfigurationVariant(feishuLike, {}), {
    status: 'selected',
    branchId: 'webhook',
  });
  assert.deepEqual(resolveConfigurationVariant(feishuLike, { connectionMode: undefined }), {
    status: 'selected',
    branchId: 'webhook',
  });
  const { default: _omit, ...noDefaultMode } = feishuLike.configuration![1]!;
  const withoutDefault = {
    ...feishuLike,
    configuration: feishuLike.configuration!.map((field, index) =>
      index === 1 ? noDefaultMode : field,
    ),
  } as unknown as PluginManifest;
  assert.deepEqual(resolveConfigurationVariant(withoutDefault, {}), { status: 'unselected' });
});

test('resolveConfigurationVariant reports invalid for a value no branch matches', () => {
  assert.deepEqual(resolveConfigurationVariant(feishuLike, { connectionMode: 'polling' }), {
    status: 'invalid',
    value: 'polling',
  });
});

test('resolveConfigurationVariant stays unselected for manifests without variants', () => {
  const { configurationVariants: _omit, ...legacy } = feishuLike as Record<string, unknown>;
  assert.deepEqual(
    resolveConfigurationVariant(legacy as unknown as PluginManifest, { connectionMode: 'webhook' }),
    { status: 'unselected' },
  );
});

test('computeEffectiveConfiguration applies declared defaults without stored values', () => {
  const { resolution, effectiveValues } = computeEffectiveConfiguration(feishuLike, {});
  assert.deepEqual(resolution, { status: 'selected', branchId: 'webhook' });
  assert.equal(effectiveValues['connectionMode'], 'webhook');
  assert.equal(effectiveValues['appId'], undefined);
  assert.equal('verificationToken' in effectiveValues, true);
  assert.equal(effectiveValues['verificationToken'], undefined);
});

test('computeEffectiveConfiguration keeps common fields plus the active branch only', () => {
  const { resolution, effectiveValues } = computeEffectiveConfiguration(feishuLike, {
    appId: 'app-1',
    connectionMode: 'websocket',
    verificationToken: 'stale-token',
  });
  assert.deepEqual(resolution, { status: 'selected', branchId: 'websocket' });
  assert.equal(effectiveValues['appId'], 'app-1');
  assert.equal(effectiveValues['connectionMode'], 'websocket');
  assert.equal('verificationToken' in effectiveValues, false);
});

test('computeEffectiveConfiguration excludes inactive branch values even when stored', () => {
  const { effectiveValues } = computeEffectiveConfiguration(videoGenLike, {
    authType: 'apikey',
    apiKey: 'key',
    accessKey: 'access',
    secretKey: 'secret',
    model: 'cogvideox',
  });
  assert.equal(effectiveValues['apiKey'], 'key');
  assert.equal('accessKey' in effectiveValues, false);
  assert.equal('secretKey' in effectiveValues, false);
  assert.equal(effectiveValues['model'], 'cogvideox');
});

test('computeEffectiveConfiguration serves a field shared by several branches in each of them', () => {
  const jwt = computeEffectiveConfiguration(videoGenLike, {
    authType: 'jwt-hs256',
    accessKey: 'access',
    secretKey: 'secret',
  });
  assert.equal(jwt.effectiveValues['accessKey'], 'access');
  assert.equal(jwt.effectiveValues['secretKey'], 'secret');
  assert.equal('apiKey' in jwt.effectiveValues, false);

  const hmac = computeEffectiveConfiguration(videoGenLike, {
    authType: 'hmac-sha256-v4',
    accessKey: 'access',
    secretKey: 'secret',
  });
  assert.equal(hmac.effectiveValues['accessKey'], 'access');
  assert.equal(hmac.effectiveValues['secretKey'], 'secret');
});

test('computeEffectiveConfiguration does not fall back on an invalid discriminator value', () => {
  const { resolution, effectiveValues } = computeEffectiveConfiguration(feishuLike, {
    appId: 'app-1',
    connectionMode: 'polling',
  });
  assert.deepEqual(resolution, { status: 'invalid', value: 'polling' });
  assert.equal(effectiveValues['connectionMode'], 'polling');
  assert.equal(effectiveValues['appId'], 'app-1');
  assert.equal('verificationToken' in effectiveValues, false);
});

test('computeEffectiveConfiguration leaves legacy manifests fully common', () => {
  const legacy = {
    pluginId: 'dev.clowder.fixture.legacy',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Legacy',
    features: [{ id: 'echo', name: 'Echo', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin' },
    configuration: [
      { key: 'appId', label: 'App ID', kind: 'string', required: true },
      { key: 'token', label: 'Token', kind: 'secret', required: true },
    ],
  } as unknown as PluginManifest;
  const { resolution, effectiveValues } = computeEffectiveConfiguration(legacy, {
    appId: 'app-1',
    token: 'tok',
  });
  assert.deepEqual(resolution, { status: 'unselected' });
  assert.deepEqual(effectiveValues, { appId: 'app-1', token: 'tok' });
});

test('buildVariantValidationSchema compiles oneOf branches with discriminator-required fields', () => {
  const schema = buildVariantValidationSchema(feishuLike);
  assert.equal(schema['type'], 'object');
  const oneOf = schema['oneOf'] as Array<Record<string, unknown>>;
  assert.equal(oneOf.length, 2);

  const webhook = oneOf[0]!;
  assert.deepEqual(webhook['required'], ['connectionMode', 'verificationToken']);
  const webhookProperties = webhook['properties'] as Record<string, unknown>;
  assert.deepEqual(webhookProperties['connectionMode'], { const: 'webhook' });
  assert.deepEqual(webhookProperties['verificationToken'], { minLength: 1 });

  const websocket = oneOf[1]!;
  assert.deepEqual(websocket['required'], ['connectionMode']);
  assert.equal(
    'verificationToken' in (websocket['properties'] as Record<string, unknown>),
    false,
  );
});

test('buildVariantValidationSchema keeps required:false branch fields optional', () => {
  const manifest = structuredClone(videoGenLike) as PluginManifest;
  const apiKey = manifest.configuration!.find((field) => field.key === 'apiKey')!;
  (apiKey as { required: boolean }).required = false;
  const schema = buildVariantValidationSchema(manifest);
  const oneOf = schema['oneOf'] as Array<Record<string, unknown>>;
  assert.ok(oneOf.every((branch) => !(branch['required'] as string[]).includes('apiKey')));

  (apiKey as { required: boolean }).required = true;
  const requiredSchema = buildVariantValidationSchema(manifest);
  const requiredOneOf = requiredSchema['oneOf'] as Array<Record<string, unknown>>;
  const apikeyBranch = requiredOneOf.find((branch) =>
    (branch['required'] as string[]).includes('apiKey'),
  );
  assert.ok(apikeyBranch);
  assert.deepEqual((apikeyBranch!['properties'] as Record<string, unknown>)['apiKey'], {
    minLength: 1,
  });
  assert.equal(
    requiredOneOf.filter((branch) => (branch['required'] as string[]).includes('apiKey'))
      .length,
    1,
  );
});

test('buildVariantValidationSchema resolves requiredWhen against the discriminator statically', () => {
  const manifest = structuredClone(videoGenLike) as PluginManifest;
  const apiKey = manifest.configuration!.find((field) => field.key === 'apiKey')!;
  (apiKey as { required: boolean; requiredWhen?: unknown }).required = false;
  (apiKey as { requiredWhen?: unknown }).requiredWhen = { key: 'authType', value: 'apikey' };
  const oneOf = buildVariantValidationSchema(manifest)['oneOf'] as Array<Record<string, unknown>>;
  const apikeyBranch = oneOf.find((branch) =>
    (branch['required'] as string[]).includes('apiKey'),
  );
  assert.ok(apikeyBranch);
  assert.equal(
    (oneOf.find((branch) => !((branch['required'] as string[]).includes('apiKey'))) !==
      undefined),
    true,
  );
});

test('buildVariantValidationSchema returns an empty oneOf for legacy manifests', () => {
  const legacy = structuredClone(feishuLike) as Record<string, unknown>;
  delete legacy['configurationVariants'];
  const schema = buildVariantValidationSchema(legacy as unknown as PluginManifest);
  assert.deepEqual(schema, { type: 'object', oneOf: [] });
});

test('variant module stays browser-safe: no ajv or node: imports', async () => {
  const source = await readFile(new URL('./variant.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"](?:node:|\.)[^'"]*ajv/);
  assert.doesNotMatch(source, /from\s+['"]node:/);
  assert.doesNotMatch(source, /require\(/);
});
