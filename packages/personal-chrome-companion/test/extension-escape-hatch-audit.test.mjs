import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const extension = new URL('../extension/', import.meta.url);

async function source(name) {
  return readFile(new URL(name, extension), 'utf8');
}

async function sourceFiles() {
  const entries = await readdir(extension);
  return entries.filter((name) => name.endsWith('.js') || name.endsWith('.mjs'));
}

test('ships an MV3 extension with a same-origin SPA receiver and narrow F247 Native Messaging surface', async () => {
  const manifest = JSON.parse(await source('manifest.json'));

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'tabs', 'scripting', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/c/*']);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ['https://chatgpt.com/c/*'],
      js: ['content-script.js'],
      run_at: 'document_idle',
    },
  ]);
  assert.equal(manifest.background.service_worker, 'service-worker.js');
});

test('extension source has no focus, navigation, cookie, debugger, private API, storage, or network escape hatch', async () => {
  const combined = await Promise.all((await sourceFiles()).map(source)).then((parts) =>
    parts.join('\n'),
  );

  for (const forbidden of [
    'tabs.update',
    'tabs.create',
    'tabs.reload',
    'tabs.highlight',
    'tabs.move',
    'chrome.windows',
    'chrome.cookies',
    'chrome.debugger',
    'chrome.storage',
    'chrome.downloads',
    'chrome.webRequest',
    'chrome.declarative',
    'fetch(',
    'XMLHttpRequest',
  ]) {
    assert.doesNotMatch(combined, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('chrome.scripting is used only to inject the bundled content script into the bound tab', async () => {
  const combined = await Promise.all((await sourceFiles()).map(source)).then((parts) =>
    parts.join('\n'),
  );

  for (const forbidden of ['executeScript\\(\\{ target: \\{ tabId \\}, func', 'world:', 'injectImmediately']) {
    assert.doesNotMatch(combined, new RegExp(forbidden));
  }
  const serviceWorker = await source('service-worker.js');
  assert.match(serviceWorker, /chrome\.scripting\.executeScript\(\{ target: \{ tabId \}, files: \['content-script\.js'\] \}\)/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{ url: `https:\/\/chatgpt\.com\/c\/\$\{conversationId\}\*` \}\)/);
  assert.match(serviceWorker, /chrome\.tabs\.sendMessage\(tabId, request\)/);
});
