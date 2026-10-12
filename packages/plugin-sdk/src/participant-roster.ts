import { assertPluginParticipant, assertPluginParticipantRosterInput, type PluginParticipant, type PluginParticipantRosterInput } from '@clowder-ai/plugin-contract';
export type { PluginParticipant, PluginParticipantRosterInput } from '@clowder-ai/plugin-contract';

/** Current authenticated owner or same-owner verified native invocation only.
 * Host derives instance/method scope from the admitted contribution, never input authority. */
export interface PluginParticipantRosterHost {
  listForNativeContribution(input: PluginParticipantRosterInput): Promise<readonly PluginParticipant[]>;
}
export function createParticipantRosterClient(host: PluginParticipantRosterHost, assertActive: () => void): PluginParticipantRosterHost {
  if (!host || typeof host.listForNativeContribution !== 'function') throw new TypeError('Host participant roster port requires listForNativeContribution');
  return Object.freeze({
    async listForNativeContribution(input: PluginParticipantRosterInput) {
      assertActive();
      assertPluginParticipantRosterInput(input);
      const result = await host.listForNativeContribution(Object.freeze({ contributionId: input.contributionId }));
      assertActive();
      if (!Array.isArray(result)) throw new TypeError('Invalid PluginParticipant roster');
      return Object.freeze(result.map(value => {
        assertPluginParticipant(value);
        return Object.freeze({ catId: value.catId, displayName: value.displayName, defaultModel: value.defaultModel, supported: value.supported,
          ...(value.nickname === undefined ? {} : { nickname: value.nickname }),
          ...(value.variantLabel === undefined ? {} : { variantLabel: value.variantLabel }),
          ...(value.roleDescription === undefined ? {} : { roleDescription: value.roleDescription }),
          ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
        });
      }));
    },
  });
}
