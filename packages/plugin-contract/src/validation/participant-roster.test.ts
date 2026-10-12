import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPluginParticipant, assertPluginParticipantRosterInput } from './participant-roster.js';
test('participant DTO retains public required and optional fields without inventing eligible authority', () => {
  const row = { catId: 'cat', displayName: 'Cat', defaultModel: 'model', supported: false };
  assertPluginParticipant(row);
  assertPluginParticipant({ ...row, nickname: 'Kit', variantLabel: 'Sol', roleDescription: 'Role', avatar: 'data:image/webp;base64,UklGRg==' });
  for (const value of [{ ...row, supported: 'true' }, { ...row, available: true }, { ...row, eligible: true },
    { ...row, policy: {} }, { ...row, avatar: '/private/file.webp' }, { ...row, avatar: 'data:image/webp;base64,' + 'A'.repeat(1200) }]) {
    assert.throws(() => assertPluginParticipant(value), /PluginParticipant/);
  }
});
test('participant roster input is exactly the bounded UTF16 trim-equal contribution coordinate', () => {
  assertPluginParticipantRosterInput({ contributionId: 'x'.repeat(256) });
  for (const value of [{ contributionId: '' }, { contributionId: 'x'.repeat(257) }, { contributionId: '😀'.repeat(129) },
    { contributionId: 'native\n' }, { contributionId: 'native', method: 'forged' }, { contributionId: 'native', instanceId: 'forged' }]) {
    assert.throws(() => assertPluginParticipantRosterInput(value), /PluginParticipantRosterInput/);
  }
});
