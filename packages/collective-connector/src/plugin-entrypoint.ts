import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { definePlugin, definePluginModule, type FeatureContext, type FeatureActivation, type PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { BROWSER_SERVICE_LIMITS, type BrowserServiceContribution } from '@clowder-ai/plugin-sdk';
import { createNodeHttpAdapter } from './node-http-adapter.js';
import { createLocalServiceTransport } from './local-service-transport.js';
import { createRecoveryActions } from './recovery-actions.js';
import { CollectiveConnector } from './business/connector/connector.js';
import { GitHubAppManifestSetup } from './business/service/github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from './business/service/github-human-auth-provider.js';
import { CollectiveServiceStore } from './business/service/store.js';
import { createSecret } from './business/service/persistence.js';

export type CollectivePluginModuleOptions = Readonly<Record<string, never>>;

async function readBootstrapSecret(path: string): Promise<string> {
  const secret = (await readFile(path, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Private owner bootstrap credential is invalid');
  return secret;
}

async function escrowBootstrapSecret(path: string): Promise<string> {
  try { return await readBootstrapSecret(path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const secret = createSecret();
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(secret + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); }
  finally { await directory.close(); }
  return secret;
}

async function writeBootstrapLink(path: string, link: string): Promise<void> {
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporaryPath, link + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally { await rm(temporaryPath, { force: true }); }
}

async function activateService(context: FeatureContext, declaration: BrowserServiceContribution): Promise<FeatureActivation> {
  if (!context.browserServices) throw new Error('Collective requires the Host browser-service binding before start');
  const binding = await context.browserServices.getBinding('collective-client-api');
  await binding.assertCurrent();
  const origin = new URL(binding.origin), parent = new URL(binding.parentOrigin);
  if (origin.origin !== binding.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
    !origin.port || origin.port === '3001' || origin.port === '3002' || origin.username || origin.password ||
    parent.origin !== binding.parentOrigin || !['http:', 'https:'].includes(parent.protocol) || parent.username || parent.password ||
    binding.clientBuildId !== 'collective-client-v2' || !/^[a-f0-9]{64}$/.test(binding.assetDigest) ||
    Object.keys(binding.limits).length !== Object.keys(BROWSER_SERVICE_LIMITS).length ||
    Object.entries(BROWSER_SERVICE_LIMITS).some(([key, value]) => binding.limits[key as keyof typeof BROWSER_SERVICE_LIMITS] !== value)) throw new Error('Collective Host binding is invalid');
  const allowedHostOrigins = [binding.parentOrigin, binding.origin];
  const dataDirectory = join(context.dataDirectory, 'service');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const provider = new ConfigurableGitHubHumanAuthProvider({});
  const githubAppSetup = await GitHubAppManifestSetup.open({ dataDirectory, provider });
  const bootstrapSecretPath = join(dataDirectory, 'owner-bootstrap.secret');
  const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: provider,
    clientBuildId: binding.clientBuildId, humanAuthRedirectUri: binding.origin + '/api/auth/github/callback',
    createBootstrapSecret: () => escrowBootstrapSecret(bootstrapSecretPath),
  });
  const bootstrapSecret = opened.store.getMetadata().bootstrapNeeded ? await readBootstrapSecret(bootstrapSecretPath) : undefined;
  if (!bootstrapSecret) await rm(bootstrapSecretPath, { force: true });
  const bootstrapLinkPath = join(dataDirectory, 'owner-bootstrap.url');
  if (bootstrapSecret) await writeBootstrapLink(bootstrapLinkPath, binding.origin + '#bootstrap=' + encodeURIComponent(bootstrapSecret));
  await binding.assertCurrent();
  const connector = await CollectiveConnector.open({ dataDirectory: join(context.dataDirectory, 'connector'),
    // Native verification/control is not granted by browser-service transport.
    verifyAgent: async () => false, localTransport: createLocalServiceTransport(context.browserServices, binding, opened.store) });
  const contribution = declaration;
  const dispatch = createNodeHttpAdapter({ store: opened.store, allowedHostOrigins, bootstrapLinkPath, githubAppSetup }, binding, contribution);
  let stopped = false;
  return {
    actions: {
      ...createRecoveryActions(connector, binding),
      'collective.http.dispatch': async (input, native, caller) => {
        if (stopped || caller?.kind !== 'http') throw new Error('Collective HTTP context is required');
        return dispatch(input, native, caller);
      },
      'collective.service.status': async () => {
        if (stopped) throw new Error('Collective module is stopped');
        // Access is revoked by the same SDK session on disable.
        void context.dataDirectory;
        return { render: 'status', data: { state: 'running', url: binding.origin, ...opened.store.getMetadata(), connections: await connector.listConnections() } };
      },
    },
    async dispose() {
      stopped = true;

      if (!opened.store.getMetadata().bootstrapNeeded) await rm(bootstrapSecretPath, { force: true });
    },
  };
}

export function createCollectivePluginModule(_options: CollectivePluginModuleOptions = {}): PluginModuleEntrypoint {
  return definePluginModule(manifest => {
    const plugin = definePlugin({ manifest });
    const declaration = plugin.manifest.contributions?.find((item): item is BrowserServiceContribution => item.type === 'browser-service' && item.id === 'collective-client-api');
    if (!declaration) throw new Error('Collective browser-service declaration is missing');
    return definePlugin({ manifest, activate: { 'collective-backend': context => activateService(context, declaration) } });
  });
}

export default createCollectivePluginModule();
