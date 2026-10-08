


/** Internal identity carried by an authenticated invocation after executor bind. */
export interface ManagedWorkBinding {
  readonly workId: string;
  readonly attemptId: string;
}
