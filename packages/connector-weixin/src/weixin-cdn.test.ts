import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadMediaFromCdn } from './weixin-cdn.js';

test('inbound CDN failures never expose the private locator or AES key in logs and errors', async () => {
  const logs: unknown[] = [];
  const log = {
    info: (...args: readonly unknown[]) => { logs.push(args); },
    warn: (...args: readonly unknown[]) => { logs.push(args); },
    error: (...args: readonly unknown[]) => { logs.push(args); },
    debug: (...args: readonly unknown[]) => { logs.push(args); },
  };
  const privateUrl = 'https://novac2c.cdn.weixin.qq.com/c2c/download?secret-locator=private';
  const aesKey = '00112233445566778899aabbccddeeff';
  await assert.rejects(downloadMediaFromCdn({
    platformKey: JSON.stringify({ fullUrl: privateUrl, aesKey }),
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    log,
    fetchFn: async () => new Response('provider echoed secret-locator=private', { status: 500 }),
  }), (error: Error) => {
    assert.equal(error.message.includes('secret-locator'), false);
    assert.equal(error.message.includes(aesKey), false);
    return true;
  });
  const observable = JSON.stringify(logs);
  assert.equal(observable.includes('secret-locator'), false);
  assert.equal(observable.includes(aesKey), false);
});
