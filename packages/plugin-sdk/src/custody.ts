import {
  assertCustodyContract,
  type CustodyCanonicalizeInput, type CustodyCanonicalizeResult,
  type CustodyPreflightInput, type CustodyPreflightResult,
  type CustodyCompleteInput, type CustodyCompleteResult,
  type PredicateFreshnessInput, type PredicateFreshnessResult,
  type PredicateCompletionInput, type PredicateCompletionResult,
  type PredicateProviderBinding,
} from '@clowder-ai/plugin-contract';

export interface PluginCustodyHost {
  canonicalize(input: CustodyCanonicalizeInput): Promise<CustodyCanonicalizeResult>;
  preflight(input: CustodyPreflightInput): Promise<CustodyPreflightResult>;
  complete(input: CustodyCompleteInput): Promise<CustodyCompleteResult>;
}
interface VerifierContextBase {
  readonly tenantScope: string;
  readonly installationProjectRoot: string;
  readonly binding: PredicateProviderBinding;
  readonly assignment: { readonly holderCatIds: readonly string[]; readonly holderThreadId: string };
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export type PluginPredicateVerifierContext = VerifierContextBase & (
  | { readonly phase: 'freshness'; readonly principal: { readonly catId: string; readonly threadId: string; readonly userId: string } }
  | { readonly phase: 'completion'; readonly principal: { readonly catId: string; readonly threadId: string; readonly userId: string; readonly invocationId: string } }
);
export type PluginPredicateVerifier = (
  input: PredicateFreshnessInput | PredicateCompletionInput,
  context: PluginPredicateVerifierContext,
) => Promise<PredicateFreshnessResult | PredicateCompletionResult>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Snapshot JSON wire inputs so an adapter cannot mutate a caller's candidate. */
function snapshot<T>(value: T): T { return freeze(structuredClone(value)); }

export function createCustodyClient(host: PluginCustodyHost | undefined, assertActive: () => void): PluginCustodyHost {
  return {
    async canonicalize(input) {
      assertActive(); assertCustodyContract('CustodyCanonicalizeInput', input);
      if (!host) throw new Error('Host custody port unavailable');
      const result = await host.canonicalize(snapshot(input));
      assertActive(); assertCustodyContract('CustodyCanonicalizeResult', result); return snapshot(result);
    },
    async preflight(input) {
      assertActive(); assertCustodyContract('CustodyPreflightInput', input);
      if (!host) throw new Error('Host custody port unavailable');
      const result = await host.preflight(snapshot(input));
      assertActive(); assertCustodyContract('CustodyPreflightResult', result); return snapshot(result);
    },
    async complete(input) {
      assertActive(); assertCustodyContract('CustodyCompleteInput', input);
      if (!host) throw new Error('Host custody port unavailable');
      const result = await host.complete(snapshot(input));
      assertActive(); assertCustodyContract('CustodyCompleteResult', result); return snapshot(result);
    },
  };
}

/** Host must additionally isolate business ALS, validate bindings, fence IO and
 * bind the result to its frozen candidate. This wrapper grants no authority. */
export function guardPredicateVerifier(
  phase: PluginPredicateVerifierContext['phase'], handler: PluginPredicateVerifier, assertActive: () => void,
): PluginPredicateVerifier {
  return async (input, context) => {
    assertActive();
    if (!context || context.phase !== phase || typeof context.assertCurrent !== 'function' || !context.signal) throw new TypeError('Host verifier context required');
    assertCustodyContract('PredicateProviderBinding', context.binding);
    if (context.tenantScope !== context.binding.tenantScope || context.installationProjectRoot !== context.binding.installationProjectRoot ||
        context.principal.userId !== context.tenantScope ||
        (phase === 'completion' && !('invocationId' in context.principal && context.principal.invocationId))) throw new TypeError('Verifier context scope mismatch');
    const inputKind = phase === 'freshness' ? 'PredicateFreshnessInput' : 'PredicateCompletionInput';
    assertCustodyContract(inputKind, input);
    const request = snapshot(input);
    const common = { ...context, binding: snapshot(context.binding), assignment: snapshot(context.assignment) };
    const boundContext: PluginPredicateVerifierContext = context.phase === 'completion'
      ? Object.freeze({ ...common, phase: 'completion', principal: snapshot(context.principal) })
      : Object.freeze({ ...common, phase: 'freshness', principal: snapshot(context.principal) });
    context.signal.throwIfAborted(); await context.assertCurrent(); assertActive();
    const result = await handler(request, boundContext);
    context.signal.throwIfAborted(); await context.assertCurrent(); assertActive();
    assertCustodyContract(phase === 'freshness' ? 'PredicateFreshnessResult' : 'PredicateCompletionResult', result);
    if (result.status === 'verified') {
      if (result.freshnessKey !== request.predicate.freshnessKey) throw new TypeError('Verifier freshness mismatch');
      if (phase === 'completion' && (!('predicateDigest' in result) || result.predicateDigest !== request.predicate.digest ||
          !('evidenceRefs' in request) || !request.evidenceRefs.includes(result.evidenceRef))) throw new TypeError('Verifier evidence mismatch');
    }
    return snapshot(result);
  };
}
