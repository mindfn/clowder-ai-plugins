export type Data = { [key: string]: any };
export type Section = 'goal' | 'scope' | 'run' | 'rules' | 'design' | 'feedback' | 'baseline';

export interface InitPlan extends Data {
  section: Section;
  role: 'prepare' | 'evaluate' | 'analyze';
  deps: Section[];
  ask: string;
  human?: string[];
  docs?: string[];
  exec?: boolean;
  unknowns?: string;
  next?: string;
}

export interface PrepItem extends Data {
  id: string;
  section: Section;
  title: string;
  value: string;
  state: 'uninvestigated' | 'preparing' | 'submitted' | 'confirmed';
  neededFrom: 'human' | 'agent' | null;
}

export interface InitStep {
  rev: number;
  base: Partial<Record<Section, number>>;
  stale: boolean;
  redo: boolean;
  unknowns?: string;
  next?: string;
}

export interface InitExecution {
  id: string;
  state: 'started' | 'cancelled' | 'failed' | 'blocked' | 'missing';
  by: string;
  base: Partial<Record<Section, number>>;
  reason?: string;
  recoveryUrl?: string;
  item?: string;
  note?: string;
  invocationId?: string;
}

export interface Experiment extends Data {
  objective: Data;
  prep: PrepItem[];
  members: Data[];
  plan: { k: Section; role: string; deps: Section[] }[];
  steps?: Partial<Record<Section, InitStep>>;
  exec?: Partial<Record<Section, InitExecution>>;
  seq?: number;
}

export interface OutboxEntry extends Data {
  id: string;
  kind: 'createThread' | 'message' | 'agent' | 'schedule' | 'run' | 'executor' | 'reevaluate';
  objective: string;
}

export interface RsiState {
  now: number;
  projects: Data[];
  analysis: Record<string, Data>;
  groups: Record<string, Data[]>;
  units: Record<string, Data[]>;
  objectives: Record<string, Data[]>;
  policy: Record<string, Data>;
  library: Record<string, Data[]>;
  hostKinds: string[];
  details: Record<string, Data>;
  experiments: Record<string, Experiment>;
  outbox: OutboxEntry[];
}

export interface RsiStorage {
  list(): Promise<Readonly<Record<string, { revision: number; value: unknown }>>>;
  get(key: string): Promise<{ revision: number; value: unknown } | undefined>;
  compareAndSet(key: string, revision: number | null, value: RsiState): Promise<{ applied: boolean }>;
}

export interface OwnerContext {
  kind: 'owner-http-request';
  userId: string;
  pluginInstanceId: string;
  operation: 'read' | 'write';
  assertCurrent(): Promise<void>;
}

export interface ToolContext {
  catId: string;
  threadId: string;
  userId: string;
  invocationId: string;
  assertCurrent(): Promise<void>;
}

export interface HostThread {
  id: string;
  projectRef?: string;
  lastActiveAt: number;
}

export interface RsiHost {
  pluginInstanceId: string;
  storage: RsiStorage;
  threads: {
    list(options?: { limit?: number; before?: { id: string; lastActiveAt: number } }): Promise<readonly HostThread[]>;
    get(id: string): Promise<HostThread | null>;
    create(input: { title: string; projectRef: string; participants: string[] }): Promise<HostThread>;
  };
  messaging: {
    subscribe(input: { threadId: string; method: string }): Promise<void>;
    send(input: { threadId: string; idempotencyKey: string; wake?: { catId: string; exact: true }; payload: {
      provenance: { epistemicStatus: 'observation' | 'user_intent' };
      elements: ({ elementId: string; kind: 'text'; payload: { text: string } } |
        { elementId: string; kind: 'rich_block'; payload: { id: string; kind: 'card'; v: 1; title: string; bodyMarkdown: string } })[];
    } }): Promise<{ messageId: string }>;
  };
  dataPath: string;
  log(level: 'info' | 'error', message: string, fields?: Data): void;
}
