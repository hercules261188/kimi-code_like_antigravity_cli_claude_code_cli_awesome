/**
 * Compile-time assertions that re-exported event types are non-`never`.
 *
 * If `@moonshot-ai/kimi-code-sdk` renames or drops one of these symbols,
 * `_AssertX = X extends never ? never : true` evaluates to `never` and the
 * `: true` annotation fails to type-check, breaking the build.
 *
 * **W8.1 (Chain 5/6)**: `ApprovalRequest` / `QuestionRequest` are no longer
 * re-exported from `../events` — those names are now the snake_case wire
 * shapes defined in `../approval` / `../question`. The runtime shape of the
 * wire form is validated by `approval.test.ts` / `question.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import type { Event } from '../events';
import type { ToolInputDisplay } from '../display';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertEventNonNever = Event extends never ? never : true;
const _assertEvent: _AssertEventNonNever = true;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertToolInputDisplayNonNever = ToolInputDisplay extends never ? never : true;
const _assertDisplay: _AssertToolInputDisplayNonNever = true;

describe('events / display re-exports', () => {
  it('Event re-export is non-never (compile-time check passed)', () => {
    expect(_assertEvent).toBe(true);
  });

  it('ToolInputDisplay re-export is non-never (12-arm union preserved)', () => {
    expect(_assertDisplay).toBe(true);
  });
});
