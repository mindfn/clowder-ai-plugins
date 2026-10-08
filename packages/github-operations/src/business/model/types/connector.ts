


/** Source metadata attached to connector-transport messages. */
export interface ConnectorSource {
  /** Stable connector identifier (used for routing + styling) */
  readonly connector: string;
  /** Human-readable display name */
  readonly label: string;
  /** Emoji or icon URL for avatar position */
  readonly icon: string;
  /** Link to original source (e.g., PR URL) */
  readonly url?: string;
  /** Connector-specific metadata (e.g. presentation='system_notice', debugging, routing) */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** F134: Original sender info for group chat messages (message-level binding, not thread-level) */
  readonly sender?: { readonly id: string; readonly name?: string };
}
