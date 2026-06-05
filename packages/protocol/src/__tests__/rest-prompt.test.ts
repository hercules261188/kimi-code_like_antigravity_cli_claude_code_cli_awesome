/**
 * `/v1/sessions/{sid}/prompts` REST endpoint schemas (REST.md §3.5).
 *
 * Covers PromptSubmission body + PromptSubmitResult + PromptAbortResponse.
 */

import { describe, expect, it } from 'vitest';

import {
  promptAbortResponseSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
} from '../rest/prompt';

describe('promptSubmissionSchema', () => {
  it('accepts a minimal text submission', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(parsed.content[0]?.type).toBe('text');
  });

  it('accepts metadata', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [{ type: 'text', text: 'hi' }],
      metadata: { source: 'cli' },
    });
    expect(parsed.metadata).toEqual({ source: 'cli' });
  });

  it('accepts image + text mixed content', () => {
    const parsed = promptSubmissionSchema.parse({
      content: [
        { type: 'text', text: 'see attached' },
        { type: 'image', source: { kind: 'url', url: 'https://a.png' } },
      ],
    });
    expect(parsed.content).toHaveLength(2);
  });

  it('rejects empty content array', () => {
    expect(
      promptSubmissionSchema.safeParse({ content: [] }).success,
    ).toBe(false);
  });

  it('rejects missing content', () => {
    expect(promptSubmissionSchema.safeParse({} as unknown).success).toBe(false);
  });
});

describe('promptSubmitResultSchema', () => {
  it('parses the result shape', () => {
    const parsed = promptSubmitResultSchema.parse({
      prompt_id: 'prompt_01HZ',
      user_message_id: 'msg_sess_01_000000',
    });
    expect(parsed.prompt_id).toBe('prompt_01HZ');
  });

  it('rejects empty prompt_id', () => {
    expect(
      promptSubmitResultSchema.safeParse({ prompt_id: '', user_message_id: 'msg' })
        .success,
    ).toBe(false);
  });
});

describe('promptAbortResponseSchema', () => {
  it('parses { aborted: true } success shape', () => {
    const parsed = promptAbortResponseSchema.parse({ aborted: true, at_seq: 7 });
    expect(parsed.aborted).toBe(true);
    expect(parsed.at_seq).toBe(7);
  });

  it('parses { aborted: false } idempotent shape (used with envelope.code=40903)', () => {
    const parsed = promptAbortResponseSchema.parse({ aborted: false });
    expect(parsed.aborted).toBe(false);
  });
});
