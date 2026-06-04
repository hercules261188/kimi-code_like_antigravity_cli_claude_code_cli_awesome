import type { TokenUsage } from '@moonshot-ai/kosong';

import type { PromptOrigin } from '../agent/context';
import { isAbortError } from '../loop/errors';
import {
  abortError,
  createDeadlineAbortSignal,
  isUserCancellation,
} from '../utils/abort';

const SUBAGENT_LAUNCH_BATCH_SIZE = 10;
const SUBAGENT_QUEUE_LAUNCH_DELAY_MS = 500;
const RATE_LIMIT_429_MESSAGE =
  "429 We're receiving too many requests at the moment. Please wait a moment and try again.";
const RATE_LIMIT_429_BODY =
  "We're receiving too many requests at the moment. Please wait a moment and try again.";

export type QueuedSubagentTask<T = unknown> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin;
};

export type QueuedSubagentRunOptions = {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
};

export type QueuedSubagentRunResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly profileName: string;
  readonly status: 'completed' | 'failed';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type QueuedSubagentAttemptOutcome<T> =
  | {
      readonly kind: 'rate_limited';
      readonly task: QueuedSubagentTask<T>;
    }
  | {
      readonly kind: 'result';
      readonly result: QueuedSubagentRunResult<T>;
    };

type QueuedSubagentReadinessOutcome<T> =
  | {
      readonly kind: 'ready';
      readonly task: QueuedSubagentTask<T>;
    }
  | {
      readonly kind: 'rate_limited';
      readonly task: QueuedSubagentTask<T>;
    };

type QueuedSubagentAttempt<T> = {
  readonly task: QueuedSubagentTask<T>;
  readonly promise: Promise<QueuedSubagentAttemptOutcome<T>>;
  readonly readiness: Promise<QueuedSubagentReadinessOutcome<T>>;
  readonly rateLimit: Promise<QueuedSubagentAttempt<T>>;
  settled: boolean;
  ready: boolean;
  readinessSettled: boolean;
};

type SubagentLaunchQueueHost = {
  readonly runQueuedTaskAttempt: <T>(
    task: QueuedSubagentTask<T>,
    options: QueuedSubagentRunOptions,
    totalTimedOut: () => boolean,
    markReady: () => void,
  ) => Promise<QueuedSubagentAttemptOutcome<T>>;
};

export class SubagentLaunchQueue {
  constructor(private readonly host: SubagentLaunchQueueHost) {}

  async run<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    let totalDeadline: ReturnType<typeof createDeadlineAbortSignal> | undefined;
    try {
      totalDeadline =
        options.totalTimeoutMs === undefined
          ? undefined
          : createDeadlineAbortSignal(options.signal, options.totalTimeoutMs);
      return await this.runWithSignal(
        tasks,
        {
          signal: totalDeadline?.signal ?? options.signal,
          timeoutMs: options.timeoutMs,
          totalTimeoutMs: options.totalTimeoutMs,
        },
        () => totalDeadline?.timedOut() === true,
      );
    } finally {
      totalDeadline?.clear();
    }
  }

  private async runWithSignal<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
    totalTimedOut: () => boolean,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const pending = [...tasks];
    const queued: Array<QueuedSubagentTask<T>> = [];
    const active: Array<QueuedSubagentAttempt<T>> = [];
    const results: Array<QueuedSubagentRunResult<T> | undefined> = Array.from({
      length: tasks.length,
    });
    const taskIndexes = new Map(tasks.map((task, index) => [task, index]));
    let completedResults = 0;
    let launchedAttempts = 0;
    let rateLimitSeen = false;
    let lockedSlotCount: number | undefined;

    const resultIndex = (task: QueuedSubagentTask<T>): number => {
      const index = taskIndexes.get(task);
      if (index === undefined) {
        throw new Error('Queued subagent task was not registered');
      }
      return index;
    };

    const enqueue = (task: QueuedSubagentTask<T>): void => {
      if (results[resultIndex(task)] !== undefined || queued.includes(task)) return;
      const insertAt = queued.findIndex((queuedTask) => resultIndex(queuedTask) > resultIndex(task));
      if (insertAt === -1) {
        queued.push(task);
      } else {
        queued.splice(insertAt, 0, task);
      }
    };

    const dequeue = (): QueuedSubagentTask<T> | undefined => {
      return queued.shift();
    };

    const lockSlotCount = (): void => {
      lockedSlotCount ??= Math.max(0, launchedAttempts - 2);
    };

    const launch = (task: QueuedSubagentTask<T>): QueuedSubagentAttempt<T> => {
      const readiness = deferred<QueuedSubagentReadinessOutcome<T>>();
      let attempt!: QueuedSubagentAttempt<T>;
      const promise = this.host.runQueuedTaskAttempt(task, options, totalTimedOut, () => {
        readiness.resolve({ kind: 'ready', task });
      });
      attempt = {
        task,
        promise,
        readiness: readiness.promise,
        rateLimit: promise.then((outcome) => {
          if (outcome.kind === 'rate_limited') return attempt;
          return new Promise<never>(() => {});
        }),
        settled: false,
        ready: false,
        readinessSettled: false,
      };
      launchedAttempts += 1;
      void promise.then(
        (outcome) => {
          attempt.settled = true;
          if (outcome.kind === 'rate_limited') {
            readiness.resolve({ kind: 'rate_limited', task: outcome.task });
          } else {
            readiness.resolve({ kind: 'ready', task: outcome.result.task });
          }
        },
        (error) => {
          attempt.settled = true;
          readiness.reject(error);
        },
      );
      void attempt.readiness.then(
        () => {
          attempt.readinessSettled = true;
        },
        () => {
          attempt.readinessSettled = true;
        },
      );
      active.push(attempt);
      return attempt;
    };

    const processAttempt = async (attempt: QueuedSubagentAttempt<T>): Promise<boolean> => {
      const activeIndex = active.indexOf(attempt);
      if (activeIndex !== -1) active.splice(activeIndex, 1);
      const outcome = await attempt.promise;
      if (outcome.kind === 'rate_limited') {
        rateLimitSeen = true;
        lockSlotCount();
        enqueue(outcome.task);
        return false;
      }
      results[resultIndex(outcome.result.task)] = outcome.result;
      completedResults += 1;
      return true;
    };

    const processSettledAttempts = async (): Promise<void> => {
      while (true) {
        const settled = active.find((attempt) => attempt.settled);
        if (settled === undefined) return;
        await processAttempt(settled);
      }
    };

    const waitForRampBatch = async (
      batch: readonly QueuedSubagentAttempt<T>[],
    ): Promise<boolean> => {
      while (batch.some((attempt) => !attempt.ready)) {
        const event = await nextRampEvent(batch, active, options.signal);
        if (event.kind === 'rate_limited') {
          await processAttempt(event.attempt);
          return false;
        }
        if (event.outcome.kind === 'rate_limited') {
          await processAttempt(event.attempt);
          return false;
        }
        event.attempt.ready = true;
        await processSettledAttempts();
        if (rateLimitSeen) return false;
      }
      return true;
    };

    const launchQueuedUpToSlotLimit = async (): Promise<void> => {
      if (lockedSlotCount === undefined) return;
      if (active.length === 0 && completedResults === 0) return;
      while (queued.length > 0 && active.length < lockedSlotCount) {
        await sleepWithSignal(SUBAGENT_QUEUE_LAUNCH_DELAY_MS, options.signal);
        if (active.length >= lockedSlotCount) return;
        const task = dequeue();
        if (task !== undefined) launch(task);
      }
    };

    try {
      while (pending.length > 0) {
        if (rateLimitSeen) break;
        const batch: Array<QueuedSubagentAttempt<T>> = [];
        const batchSize = Math.min(SUBAGENT_LAUNCH_BATCH_SIZE, pending.length);
        for (let i = 0; i < batchSize; i += 1) {
          const task = pending.shift();
          if (task === undefined) break;
          batch.push(launch(task));
        }
        if (pending.length === 0) break;
        const rampCanContinue = await waitForRampBatch(batch);
        if (!rampCanContinue) break;
      }

      for (const task of pending) {
        enqueue(task);
      }
      pending.length = 0;
      if (active.length > 0 || completedResults > 0) {
        await launchQueuedUpToSlotLimit();
      }

      while (completedResults < tasks.length) {
        options.signal.throwIfAborted();
        if (active.length === 0) {
          if (queued.length === 0) break;
          if (completedResults === 0) {
            throw new Error(
              'Could not start any subagents because every launch attempt was rate limited.',
            );
          }
          while (queued.length > 0) {
            const task = dequeue();
            if (task === undefined) break;
            results[resultIndex(task)] = failedQueuedResult(
              task,
              'No running subagents remained to open queue slots after rate-limited launches.',
            );
            completedResults += 1;
          }
          break;
        }

        const attempt = await nextSettledAttempt(active, options.signal);
        await processAttempt(attempt);
        await launchQueuedUpToSlotLimit();
      }
    } catch (error) {
      if (!totalTimedOut()) throw error;
      const message = totalTimeoutMessage(options.totalTimeoutMs);
      for (const task of tasks) {
        const index = resultIndex(task);
        if (results[index] !== undefined) continue;
        results[index] = failedQueuedResult(task, message);
      }
    }

    return results.map((result, index) => {
      if (result !== undefined) return result;
      return failedQueuedResult(tasks[index]!, 'Subagent stopped before it could finish.');
    });
  }
}

function failedQueuedResult<T>(
  task: QueuedSubagentTask<T>,
  error: string,
): QueuedSubagentRunResult<T> {
  return {
    task,
    profileName: task.profileName,
    status: 'failed',
    error,
  };
}

type RampEvent<T> =
  | {
      readonly kind: 'readiness';
      readonly attempt: QueuedSubagentAttempt<T>;
      readonly outcome: QueuedSubagentReadinessOutcome<T>;
    }
  | {
      readonly kind: 'rate_limited';
      readonly attempt: QueuedSubagentAttempt<T>;
    };

async function nextRampEvent<T>(
  batch: ReadonlyArray<QueuedSubagentAttempt<T>>,
  active: ReadonlyArray<QueuedSubagentAttempt<T>>,
  signal: AbortSignal,
): Promise<RampEvent<T>> {
  const ready = batch.find((attempt) => !attempt.ready && attempt.readinessSettled);
  if (ready !== undefined) {
    return { kind: 'readiness', attempt: ready, outcome: await ready.readiness };
  }
  signal.throwIfAborted();
  const readiness = batch
    .filter((attempt) => !attempt.ready)
    .map((attempt) =>
      attempt.readiness.then((outcome): RampEvent<T> => ({ kind: 'readiness', attempt, outcome })),
    );
  const rateLimited = active.map((attempt) =>
    attempt.rateLimit.then((rateLimitedAttempt): RampEvent<T> => ({
      kind: 'rate_limited',
      attempt: rateLimitedAttempt,
    })),
  );
  return await raceWithSignal([...readiness, ...rateLimited], signal);
}

async function nextSettledAttempt<T>(
  active: ReadonlyArray<QueuedSubagentAttempt<T>>,
  signal: AbortSignal,
): Promise<QueuedSubagentAttempt<T>> {
  const settled = active.find((attempt) => attempt.settled);
  if (settled !== undefined) return settled;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    for (const attempt of active) {
      void attempt.promise.then(
        () => {
          cleanup();
          resolve(attempt);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    }
  });
}

function raceWithSignal<T>(promises: Array<Promise<T>>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    for (const promise of promises) {
      void promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    }
  });
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timeout = undefined;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      innerResolve(value);
    };
    reject = (reason) => {
      if (settled) return;
      settled = true;
      innerReject(reason);
    };
  });
  return { promise, resolve, reject };
}

export function totalTimeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined
    ? 'Subagent batch total timeout elapsed.'
    : `Subagent batch total timeout after ${formatTimeoutMs(timeoutMs)}.`;
}

export function formatTimeoutMs(timeoutMs: number): string {
  return `${String(timeoutMs / 1000)}s`;
}

export function formatQueuedSubagentError(
  error: unknown,
  signal: AbortSignal,
  timeouts: {
    readonly subagentTimedOut: () => boolean;
    readonly subagentTimeoutMs?: number;
    readonly totalTimedOut: () => boolean;
    readonly totalTimeoutMs?: number;
  },
): string {
  if (timeouts.subagentTimedOut() && timeouts.subagentTimeoutMs !== undefined) {
    return `Subagent timed out after ${formatTimeoutMs(timeouts.subagentTimeoutMs)}.`;
  }
  if (timeouts.totalTimedOut() && timeouts.totalTimeoutMs !== undefined) {
    return totalTimeoutMessage(timeouts.totalTimeoutMs);
  }
  if (isUserCancellation(signal.reason)) {
    return 'The user manually interrupted this subagent batch.';
  }
  if (isAbortError(error)) {
    return 'The subagent was stopped before it finished.';
  }
  return errorMessage(error);
}

export function isRateLimit429Error(error: unknown): boolean {
  const message = errorMessage(error);
  if (message.includes(RATE_LIMIT_429_MESSAGE)) return true;
  if (!message.includes(RATE_LIMIT_429_BODY)) return false;
  if (message.includes('429')) return true;
  if (message.includes('provider.rate_limit')) return true;
  return maybeStatusCode(error) === 429;
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
