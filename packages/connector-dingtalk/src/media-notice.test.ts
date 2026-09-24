import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTypedMediaNotice } from './media-notice.js';

test('typed media notices render every unavailable enum without relying on fileName', () => {
  const reasons = {
    source_expired: '来源已过期',
    timeout: '处理超时',
    unavailable: '无法获取',
  } as const;
  for (const [reason, label] of Object.entries(reasons)) {
    assert.equal(renderTypedMediaNotice({
      elementId: `unavailable-${reason}`,
      kind: 'media_unavailable',
      payload: { type: 'video', reason },
    }), `⚠️ 媒体不可用：视频（${label}）`);
  }
});

test('media warning identifies its referenced media by display name or type', () => {
  const warning = {
    elementId: 'warning-1', kind: 'media_warning',
    payload: { mediaElementId: 'media-1', stage: 'transcription', reason: 'processing_failed' },
  };
  assert.equal(renderTypedMediaNotice(warning, { elements: [
    { elementId: 'media-1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_1', fileName: 'voice.opus' } },
  ] }), '⚠️ 媒体处理警告：voice.opus（转写处理失败）');
  assert.equal(renderTypedMediaNotice(warning, { elements: [
    { elementId: 'media-1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_1' } },
  ] }), '⚠️ 媒体处理警告：音频（转写处理失败）');
});

test('only typed notice elements render and malformed notices log only their elementId', () => {
  assert.equal(renderTypedMediaNotice({ elementId: 'text-1', kind: 'text', payload: { text: 'body' } }), undefined);
  assert.equal(renderTypedMediaNotice({
    elementId: 'media-1', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_1' },
  }), undefined);
  const warned: string[] = [];
  assert.equal(renderTypedMediaNotice({
    elementId: 'bad-1', kind: 'media_warning', payload: { privateLocator: 'must-not-log' },
  }, { warnInvalid: elementId => warned.push(elementId) }), undefined);
  assert.deepEqual(warned, ['bad-1']);
});
