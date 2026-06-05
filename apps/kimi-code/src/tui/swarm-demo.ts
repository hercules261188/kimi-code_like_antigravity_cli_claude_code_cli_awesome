import {
  Container,
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Focusable,
} from '@earendil-works/pi-tui';

import {
  AgentSwarmProgressComponent,
  agentSwarmGridHeightForTerminalRows,
} from './components/messages/agent-swarm-progress';
import { GutterContainer } from './components/chrome/gutter-container';
import { loadTuiConfig, TuiConfigParseError } from './config';
import { CHROME_GUTTER } from './constant/rendering';
import { createKimiTUIThemeBundle } from './theme/bundle';
import type { ColorPalette } from './theme/colors';
import { detectTerminalTheme } from './theme/detect';
import { printableChar } from './utils/printable-key';

const DEFAULT_SWARM_COUNT = 32;
const MAX_SWARM_COUNT = 256;
const FRAME_INTERVAL_MS = 80;
const INPUT_COMPLETE_MS = 500;
const TOOL_TICK_INTERVAL_MS = 520;
const LONG_RUNNING_FINISH_MS = 45_000;
const FAILED_COUNT = 2;
const CANCELLED_COUNT = 1;

export interface SwarmDemoRunOptions {
  readonly count?: string;
}

interface SwarmDemoComponentOptions {
  readonly count: number;
  readonly colors: ColorPalette;
  readonly terminalRows: () => number | undefined;
  readonly requestRender: () => void;
  readonly onExit: () => void;
}

type DemoTaskPhase = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
type DemoTaskTerminal = 'completed' | 'failed' | 'cancelled';

interface DemoTask {
  readonly index: number;
  readonly agentId: string;
  readonly description: string;
  readonly itemText: string;
  readonly spawnAtMs: number;
  readonly startAtMs: number;
  readonly finishAtMs: number;
  readonly terminal: DemoTaskTerminal;
  phase: DemoTaskPhase;
  toolTickCount: number;
  modelLineCount: number;
}

const MODEL_LINES = [
  'Reading relevant files',
  'Checking edge cases',
  'Comparing nearby patterns',
  'Validating behavior',
  'Writing concise findings',
] as const;

export async function runSwarmDemo(options: SwarmDemoRunOptions = {}): Promise<number> {
  const count = resolveSwarmCount(options.count);
  const colors = await loadSwarmDemoColors();
  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);
  let stopped = false;
  let resolveExit: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const component = new SwarmDemoComponent({
    count,
    colors,
    terminalRows: () => ui.terminal.rows,
    requestRender: () => {
      ui.requestRender();
    },
    onExit: () => {
      void stop(0);
    },
  });

  const root = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  root.addChild(component);
  ui.addChild(root);
  ui.setFocus(component);

  const cleanupHandlers: Array<() => void> = [];
  const addSignalHandler = (signal: NodeJS.Signals, code: number): void => {
    const handler = (): void => {
      void stop(code);
    };
    process.prependListener(signal, handler);
    cleanupHandlers.push(() => {
      process.off(signal, handler);
    });
  };
  addSignalHandler('SIGTERM', 143);
  if (process.platform !== 'win32') addSignalHandler('SIGHUP', 129);

  async function stop(code: number): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanupHandlers) cleanup();
    cleanupHandlers.length = 0;
    component.dispose();
    terminal.setProgress(false);
    await terminal.drainInput().catch(() => {});
    ui.stop();
    resolveExit(code);
  }

  try {
    terminal.setTitle('Kimi swarm demo');
    terminal.setProgress(true);
    ui.start();
    component.start();
    ui.requestRender(true);
  } catch (error) {
    component.dispose();
    for (const cleanup of cleanupHandlers) cleanup();
    cleanupHandlers.length = 0;
    terminal.setProgress(false);
    ui.stop();
    throw error;
  }

  return done;
}

export function resolveSwarmCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_SWARM_COUNT;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SWARM_COUNT) {
    throw new Error(
      `Invalid swarm count "${raw}". Use an integer from 1 to ${String(MAX_SWARM_COUNT)}.`,
    );
  }
  return count;
}

async function loadSwarmDemoColors(): Promise<ColorPalette> {
  try {
    const config = await loadTuiConfig();
    const resolvedTheme = config.theme === 'auto' ? await detectTerminalTheme() : config.theme;
    return createKimiTUIThemeBundle(config.theme, resolvedTheme).colors;
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    const resolvedTheme =
      error.fallback.theme === 'auto' ? await detectTerminalTheme() : error.fallback.theme;
    return createKimiTUIThemeBundle(error.fallback.theme, resolvedTheme).colors;
  }
}

export class SwarmDemoComponent extends Container implements Focusable {
  focused = false;
  private readonly tasks: DemoTask[];
  private readonly progress: AgentSwarmProgressComponent;
  private readonly requestRender: () => void;
  private readonly onExit: () => void;
  private inputComplete = false;
  private startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SwarmDemoComponentOptions) {
    super();
    this.requestRender = options.requestRender;
    this.onExit = options.onExit;
    this.tasks = createDemoTasks(options.count);
    this.progress = new AgentSwarmProgressComponent({
      description: 'Demo AgentSwarm progress',
      colors: options.colors,
      availableGridHeight: () => agentSwarmGridHeightForTerminalRows(options.terminalRows()),
      requestRender: options.requestRender,
    });
    this.progress.updateArgs({
      description: 'Demo AgentSwarm progress',
      prompt_template: 'Inspect {{item}} and report the most relevant finding.',
      items: this.tasks.map((task) => task.itemText),
    });
  }

  start(): void {
    this.disposeTimer();
    this.startedAt = Date.now();
    this.inputComplete = false;
    for (const task of this.tasks) {
      task.phase = 'pending';
      task.toolTickCount = 0;
      task.modelLineCount = 0;
    }
    this.syncProgress();
    this.timer = setInterval(() => {
      this.syncProgress();
      this.requestRender();
    }, FRAME_INTERVAL_MS);
  }

  dispose(): void {
    this.disposeTimer();
    this.progress.dispose();
  }

  override invalidate(): void {
    this.progress.invalidate();
  }

  handleInput(data: string): void {
    const printable = printableChar(data);
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d')) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.onExit();
    }
  }

  override render(width: number): string[] {
    this.syncProgress();
    return this.progress.render(width);
  }

  private disposeTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private syncProgress(): void {
    const elapsedMs = Date.now() - this.startedAt;
    if (!this.inputComplete && elapsedMs >= INPUT_COMPLETE_MS) {
      this.progress.markInputComplete();
      this.inputComplete = true;
      for (const task of this.tasks) {
        if (task.phase === 'pending') task.phase = 'queued';
      }
    }

    for (const task of this.tasks) {
      this.syncTask(task, elapsedMs);
    }
  }

  private syncTask(task: DemoTask, elapsedMs: number): void {
    if (task.phase === 'pending' && elapsedMs >= task.spawnAtMs) {
      this.progress.registerSubagent({
        agentId: task.agentId,
        description: task.description,
      });
      task.phase = 'queued';
    }

    if (task.phase === 'queued' && elapsedMs >= task.startAtMs) {
      this.progress.markStarted(task.agentId);
      task.phase = 'running';
    }

    if (task.phase === 'running') {
      const runningElapsedMs = Math.max(0, elapsedMs - task.startAtMs);
      const targetToolTicks = Math.floor(runningElapsedMs / TOOL_TICK_INTERVAL_MS);
      while (task.toolTickCount < targetToolTicks) {
        task.toolTickCount += 1;
        this.progress.recordToolCall({
          agentId: task.agentId,
          toolCallId: `${task.agentId}-tool-${String(task.toolTickCount)}`,
        });
      }

      const targetModelLines = Math.floor(runningElapsedMs / (TOOL_TICK_INTERVAL_MS * 2));
      while (task.modelLineCount < targetModelLines) {
        task.modelLineCount += 1;
        const line = MODEL_LINES[(task.modelLineCount + task.index) % MODEL_LINES.length];
        this.progress.appendModelDelta({
          agentId: task.agentId,
          delta: `${line}: ${task.itemText}\n`,
        });
      }

      if (elapsedMs >= task.finishAtMs) {
        this.finishTask(task);
      }
    }
  }

  private finishTask(task: DemoTask): void {
    switch (task.terminal) {
      case 'completed':
        this.progress.markCompleted(task.agentId, `Completed ${task.itemText}`);
        task.phase = 'completed';
        return;
      case 'failed':
        this.progress.markFailed(task.agentId, `Failed while checking ${task.itemText}`);
        task.phase = 'failed';
        return;
      case 'cancelled':
        this.progress.markCancelled(task.agentId);
        task.phase = 'cancelled';
        return;
    }
  }
}

function createDemoTasks(count: number): DemoTask[] {
  const failed = chooseTerminalIndexes(count, FAILED_COUNT, 0.42);
  const cancelled = chooseTerminalIndexes(count, CANCELLED_COUNT, 0.68, failed);

  return Array.from({ length: count }, (_item, index) => {
    const agentNumber = String(index + 1).padStart(3, '0');
    const spawnAtMs = 120 + (index % 16) * 70 + Math.floor(index / 16) * 35;
    const startAtMs = spawnAtMs + 350 + (index % 5) * 130;
    const terminal = failed.has(index)
      ? 'failed'
      : cancelled.has(index)
        ? 'cancelled'
        : 'completed';
    const finishAtMs = index === 0
      ? LONG_RUNNING_FINISH_MS
      : startAtMs + 2_200 + (index % 9) * 360 + Math.floor(index / 9) * 80;
    return {
      index,
      agentId: `demo-agent-${agentNumber}`,
      description: `Demo AgentSwarm #${String(index + 1)} (coder)`,
      itemText: demoItemText(index),
      spawnAtMs,
      startAtMs,
      finishAtMs,
      terminal,
      phase: 'pending',
      toolTickCount: 0,
      modelLineCount: 0,
    };
  });
}

function chooseTerminalIndexes(
  count: number,
  targetCount: number,
  offsetRatio: number,
  exclude: ReadonlySet<number> = new Set(),
): ReadonlySet<number> {
  const indexes = new Set<number>();
  if (count <= 1 || targetCount <= 0) return indexes;

  let cursor = Math.max(1, Math.min(count - 1, Math.floor(count * offsetRatio)));
  while (indexes.size < targetCount && indexes.size + exclude.size < count - 1) {
    if (cursor !== 0 && !exclude.has(cursor)) indexes.add(cursor);
    cursor = cursor + 3 >= count ? 1 + ((cursor + 3) % count) : cursor + 3;
  }
  return indexes;
}

function demoItemText(index: number): string {
  const files = [
    'apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts',
    'apps/kimi-code/src/tui/controllers/session-event-handler.ts',
    'apps/kimi-code/src/tui/components/messages/tool-call.ts',
    'packages/agent-core/src/tools/builtin/current.ts',
    'packages/node-sdk/src/session.ts',
    'docs/en/release-notes/changelog.md',
  ] as const;
  const file = files[index % files.length];
  return `${file}#${String(index + 1)}`;
}
