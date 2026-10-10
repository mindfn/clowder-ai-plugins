import type { BrowserServiceRequest, BrowserServiceResponse, BrowserServiceDispatchResult } from '@clowder-ai/plugin-contract';
export type { BrowserServiceContribution, BrowserServiceMethod, BrowserServiceRoute, BrowserServiceHeader,
  BrowserServiceRequest, BrowserServiceResponse, BrowserServiceFailureCode, BrowserServiceTransportFailure,
  BrowserServiceDispatchResult } from '@clowder-ai/plugin-contract';

export const BROWSER_SERVICE_LIMITS = Object.freeze({ requestBytes: 262144, responseBytes: 33554432,
  headerFields: 32, headerValueBytes: 8192, headerBytes: 32768, targetBytes: 8192, timeoutMs: 10000 } as const);
export interface BrowserServiceBinding {
  readonly contributionId: string;
  readonly origin: string;
  readonly parentOrigin: string;
  readonly clientBuildId: string;
  readonly assetDigest: string;
  readonly limits: typeof BROWSER_SERVICE_LIMITS;
  assertCurrent(): Promise<void>;
}
export interface BrowserServiceDispatchContext {
  readonly kind: 'http';
  readonly lane: 'browser' | 'local';
  readonly contributionId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export type BrowserServiceHandler = (input: { readonly request: BrowserServiceRequest }, nativeContext: undefined,
  httpContext: BrowserServiceDispatchContext) => Promise<BrowserServiceResponse>;
export interface BrowserServiceHost {
  getBinding(contributionId: string): Promise<BrowserServiceBinding>;
  dispatchLocal(contributionId: string, request: BrowserServiceRequest, options?: { readonly signal?: AbortSignal }): Promise<BrowserServiceDispatchResult>;
}
export interface PluginOwnerOperationContext {
  readonly kind: 'owner-operation';
  readonly userId: string;
  readonly pluginInstanceId: string;
  readonly operationKey: string;
  readonly actionId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export type PluginHostActionContext = BrowserServiceDispatchContext | PluginOwnerOperationContext;
