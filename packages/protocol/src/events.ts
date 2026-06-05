/**
 * Event payload type re-exports from `@moonshot-ai/kimi-code-sdk`
 * (PLAN.md D2 / D3, SCHEMAS.md §4).
 *
 * **No runtime Zod schemas.** PLAN D3 ("高频事件走 unchecked path") forbids
 * double-writing event payload schemas. The TS types below are the SOT;
 * daemon WS handlers serialize them as-is with `snake_case` field naming
 * already enforced upstream.
 *
 * `Event` is the agent-core event union (`AgentEvent & {agentId, sessionId}`).
 *
 * **Wire-shape Approval/Question request payloads** moved to `./approval` /
 * `./question` in Chain 5/6 — those are SNAKE_CASE wire shapes (with daemon-
 * minted `approval_id` / `question_id`, etc.), not the SDK's camelCase
 * in-process shapes. The W7 placeholder re-export of `ApprovalRequest` /
 * `QuestionRequest` from this module is removed (Chain 5/6); the protocol
 * `ApprovalRequest` / `QuestionRequest` types now come from `./approval` /
 * `./question` and are what WS broadcasts carry.
 *
 * Symbol mapping (this prompt → node-sdk export name):
 *   - `Event`            → `Event` (re-exported from `@moonshot-ai/agent-core`)
 */
export type { Event } from '@moonshot-ai/kimi-code-sdk';
