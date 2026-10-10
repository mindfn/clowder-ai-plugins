import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { definePlugin, definePluginModule, type FeatureContext, type PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { resolveCollectivePublicUrl } from './business/service/cli-config.js';
import { GitHubAppManifestSetup } from './business/service/github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from './business/service/github-human-auth-provider.js';
import { startCollectiveServer } from './business/service/http-server.js';
import { CollectiveServiceStore } from './business/service/store.js';
import { createSecret } from './business/service/persistence.js';

export interface CollectivePluginModuleOptions {
  readonly startServer?: typeof startCollectiveServer;
}

function servicePort(value: unknown): number {
  const port = value === undefined ? 5201 : value;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535 || port === 3001 || port === 3002) {
    throw new TypeError('service port must be an integer in 0..65535 outside reserved runtime ports');
  }
  return port;
}

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

async function activateService(context: FeatureContext, options: CollectivePluginModuleOptions) {
  const port = servicePort(await context.config.get('servicePort'));
  const origins = await context.config.get('allowedHostOrigins');
  if (origins !== undefined && typeof origins !== 'string') throw new TypeError('allowedHostOrigins must be a comma-separated string');
  const allowedHostOrigins = (origins ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => new URL(value).origin);
  const publicUrl = await context.config.get('publicUrl');
  if (publicUrl !== undefined && typeof publicUrl !== 'string') throw new TypeError('publicUrl must be a URL string');
  resolveCollectivePublicUrl(publicUrl, '127.0.0.1', port);
  const dataDirectory = join(context.dataDirectory, 'service');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const provider = new ConfigurableGitHubHumanAuthProvider({});
  const githubAppSetup = await GitHubAppManifestSetup.open({ dataDirectory, provider });
  const bootstrapSecretPath = join(dataDirectory, 'owner-bootstrap.secret');
  const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: provider,
    createBootstrapSecret: () => escrowBootstrapSecret(bootstrapSecretPath),
  });
  const bootstrapSecret = opened.store.getMetadata().bootstrapNeeded ? await readBootstrapSecret(bootstrapSecretPath) : undefined;
  if (!bootstrapSecret) await rm(bootstrapSecretPath, { force: true });
  const bootstrapLinkPath = join(dataDirectory, 'owner-bootstrap.url');
  const running = await (options.startServer ?? startCollectiveServer)({
    store: opened.store, host: '127.0.0.1', port, allowedHostOrigins,
    bootstrapLinkPath, githubAppSetup,
  });
  try {
    const url = resolveCollectivePublicUrl(publicUrl, running.host, running.port);
    opened.store.configureHumanAuthRedirectUri(new URL('/api/auth/github/callback', url).toString());
    if (bootstrapSecret) {
      await writeBootstrapLink(bootstrapLinkPath, url + '#bootstrap=' + encodeURIComponent(bootstrapSecret));
    }
  } catch (error) {
    // Until activation returns its disposer, startup owns the acquired listener.
    try { await running.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Collective activation and cleanup failed'); }
    throw error;
  }
  let stopped = false;
  return {
    actions: {
      'collective.service.status': async () => {
        if (stopped) throw new Error('Collective module is stopped');
        // Access is revoked by the same SDK session on disable.
        void context.dataDirectory;
        return { render: 'status', data: { state: 'running', url: running.url, ...opened.store.getMetadata() } };
      },
    },
    async dispose() {
      stopped = true;
      await running.close();
      if (!opened.store.getMetadata().bootstrapNeeded) await rm(bootstrapSecretPath, { force: true });
    },
  };
}

export function createCollectivePluginModule(options: CollectivePluginModuleOptions = {}): PluginModuleEntrypoint {
  return definePluginModule(manifest => definePlugin({
    manifest, activate: { 'collective-backend': context => activateService(context, options) },
  }));
}

export default createCollectivePluginModule();
