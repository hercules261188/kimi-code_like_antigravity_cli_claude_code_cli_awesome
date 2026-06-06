import type { TokenUsage } from '@moonshot-ai/kosong';

import type { RunSubagentOptions, SpawnSubagentOptions, SubagentHandle } from '.';
import type { PromptOrigin } from '../agent/context';

export type QueuedSubagentTask<T = unknown> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmItem?: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin;
  readonly resumeAgentId?: string;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
};

export type QueuedSubagentRunResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};


export interface SubagentLauncher {
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  retry(agentId: string): Promise<SubagentHandle>;
}

export class SubagentLaunchQueue<T> {
  constructor(
    private launcher: SubagentLauncher,
    private tasks: QueuedSubagentTask<T>[]
  ) { }

  run(): Promise<Array<QueuedSubagentRunResult<T>>> {
  }
}
