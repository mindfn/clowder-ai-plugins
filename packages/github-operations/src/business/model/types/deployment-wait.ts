import type { UnifiedAwaitStateV1, WaitOutcomeBaseV1 } from './wait-contract.js';


export type DeploymentSubjectRef = `deployment:${string}:${string}`;
export type DeploymentService = 'api' | 'web';

export type DeploymentWaitPredicate =
  | {
      readonly kind: 'revision_included';
      /** Frozen merge/build revision; never a mutable PR head. */
      readonly revision: string;
      readonly services: readonly DeploymentService[];
    }
  | {
      readonly kind: 'new_ready_boot';
      readonly services: readonly DeploymentService[];
    };

export interface DeploymentWaitBaseline {
  /** Assigned by the deployment ledger, independent of wall clock. */
  readonly bootSequence: number;
  readonly bootId: string;
  readonly capturedAt: number;
}

export type DeploymentAwaitStateV1 = UnifiedAwaitStateV1<
  DeploymentSubjectRef,
  DeploymentWaitBaseline,
  DeploymentWaitPredicate
> & { readonly autoRenew: false };

export interface DeploymentInclusionProofV1 {
  readonly kind: 'git_ancestry' | 'build_manifest';
  readonly targetRevision: string;
  readonly runningRevision: string;
  readonly included: boolean;
}

export interface DeploymentWaitMatchedEvidenceV1 {
  readonly kind: DeploymentWaitPredicate['kind'];
  readonly services: readonly DeploymentService[];
  readonly targetRevision?: string;
  readonly bootId: string;
  readonly bootSequence: number;
  readonly runningRevision: string | null;
  readonly observedAt: number;
  readonly proofKind?: DeploymentInclusionProofV1['kind'];
}

/** Deployment-only outcome variant; GitHub deltas cannot be stored here. */
export interface DeploymentWaitOutcomeV1 extends WaitOutcomeBaseV1<DeploymentSubjectRef> {
  readonly domain: 'deployment';
  /** Original registration time retained after the active await is consumed. */
  readonly registeredAt?: number;
  readonly deploymentMatch?: DeploymentWaitMatchedEvidenceV1;
  readonly matched?: never;
  readonly terminalSubjectState?: never;
  readonly renewal?: never;
}

export interface DeploymentWaitStateV1 {
  readonly await?: DeploymentAwaitStateV1;
  readonly waitOutcome?: DeploymentWaitOutcomeV1;
  /** Registration's existing owner turn holds first-consumer priority until its callback settles. */
  readonly currentExecutionClaim?: {
    readonly invocationId: string;
    readonly generation: number;
    readonly bootId: string;
  };
}
