/**
 * Question REST endpoint schemas (REST.md §3.6, W8.2 / Chain 6).
 *
 * 2 endpoints:
 *
 *   POST   /v1/sessions/{sid}/questions/{qid}             (resolve)
 *     Body:  QuestionResponse (answers map + method? + note?)
 *     Reply: QuestionResolveResult { resolved: true, resolved_at }
 *     Errors: 40001 / 40404 / 40902 / 41002
 *
 *   POST   /v1/sessions/{sid}/questions/{qid}:dismiss     (dismiss)
 *     Body:  empty
 *     Reply: envelope code: 40909 + data { dismissed: true, dismissed_at }
 *     This is the **first-class dismiss path** (SCHEMAS §6.3 — not the same
 *     as "all skipped"): the user pressed ESC / closed the panel before
 *     answering, agent-core receives a `null` QuestionResult.
 *
 * **Idempotency** (REST.md §3.6): a second resolve on the same question_id
 * returns envelope `code: 40902` with `data.resolved: false` (mirrors W7's
 * 40903 + W8.1's 40902 approval pattern).
 */

import { z } from 'zod';

import { questionResponseSchema } from '../question';
import { isoDateTimeSchema } from '../time';

// --- POST /v1/sessions/{sid}/questions/{qid} (resolve) ----------------------

export const questionResolveRequestSchema = questionResponseSchema;
export type QuestionResolveRequest = z.infer<typeof questionResolveRequestSchema>;

export const questionResolveResultSchema = z.object({
  resolved: z.literal(true),
  resolved_at: isoDateTimeSchema,
});
export type QuestionResolveResult = z.infer<typeof questionResolveResultSchema>;

/** Custom envelope `data` for `code: 40902` idempotent re-resolve. */
export const questionAlreadyResolvedDataSchema = z.object({
  resolved: z.literal(false),
});
export type QuestionAlreadyResolvedData = z.infer<typeof questionAlreadyResolvedDataSchema>;

// --- POST /v1/sessions/{sid}/questions/{qid}:dismiss ------------------------

/**
 * Envelope `data` shape for `code: 40909 question.dismissed` per REST.md §3.6.
 * The custom envelope uses a non-zero code intentionally (per SCHEMAS §6.3
 * the daemon broadcasts `event.question.dismissed` AND the agent's pending
 * Promise resolves with `null`, which is semantically "outcome != success
 * even though the daemon acted on the request").
 */
export const questionDismissResultSchema = z.object({
  dismissed: z.literal(true),
  dismissed_at: isoDateTimeSchema,
});
export type QuestionDismissResult = z.infer<typeof questionDismissResultSchema>;
