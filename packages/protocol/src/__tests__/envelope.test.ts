import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { envelopeSchema, errEnvelope, okEnvelope, type Envelope } from '../envelope';
import { ErrorCode, ErrorCodeReason } from '../error-codes';

describe('envelope', () => {
  it('okEnvelope round-trips through envelopeSchema', () => {
    const built = okEnvelope({ ok: true }, 'req_test');

    expect(built).toEqual({
      code: 0,
      msg: 'success',
      data: { ok: true },
      request_id: 'req_test',
    });

    const schema = envelopeSchema(z.object({ ok: z.boolean() }));
    const parsed = schema.parse(built);
    expect(parsed).toEqual(built);
  });

  it('errEnvelope round-trips with data: null', () => {
    const built = errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'session abc123 does not exist', 'req_x');

    expect(built).toEqual({
      code: 40401,
      msg: 'session abc123 does not exist',
      data: null,
      request_id: 'req_x',
    });

    const parsed = envelopeSchema(z.any()).parse(built);
    expect(parsed.data).toBeNull();
    expect(parsed.code).toBe(40401);
  });

  it('envelopeSchema rejects non-integer code', () => {
    const schema = envelopeSchema(z.unknown());
    expect(schema.safeParse({ code: 1.5, msg: 'x', data: null, request_id: 'r' }).success).toBe(
      false,
    );
  });

  it('envelopeSchema rejects missing request_id', () => {
    const schema = envelopeSchema(z.unknown());
    expect(schema.safeParse({ code: 0, msg: 'success', data: null }).success).toBe(false);
  });

  it('wire shape matches the daemon helper byte-for-byte', () => {
    // The daemon's helper (packages/daemon/src/envelope.ts) emits
    // { code, msg, data, request_id } in this order. JSON.stringify on our
    // helper output must match the same key order so W4's swap is a no-op
    // on wire bytes.
    const ours = okEnvelope({ id: 'sess_1' }, 'req_y');
    const oursJson = JSON.stringify(ours);
    expect(oursJson).toBe('{"code":0,"msg":"success","data":{"id":"sess_1"},"request_id":"req_y"}');

    const errJson = JSON.stringify(errEnvelope(40001, 'validation failed', 'req_z'));
    expect(errJson).toBe(
      '{"code":40001,"msg":"validation failed","data":null,"request_id":"req_z"}',
    );
  });
});

describe('error-codes', () => {
  it('canonical codes match REST.md §1.4', () => {
    expect(ErrorCode.SUCCESS).toBe(0);
    expect(ErrorCode.VALIDATION_FAILED).toBe(40001);
    expect(ErrorCode.SESSION_NOT_FOUND).toBe(40401);
    expect(ErrorCode.APPROVAL_EXPIRED).toBe(41001);
    expect(ErrorCode.FS_WATCH_LIMIT_EXCEEDED).toBe(42902);
    expect(ErrorCode.INTERNAL_ERROR).toBe(50001);
    expect(ErrorCode.TOOL_EXECUTION_FAILED).toBe(60001);
  });

  it('ErrorCodeReason maps every numeric code to its domain.reason label', () => {
    expect(ErrorCodeReason[ErrorCode.SESSION_NOT_FOUND]).toBe('session.not_found');
    expect(ErrorCodeReason[ErrorCode.VALIDATION_FAILED]).toBe('validation.failed');
    expect(ErrorCodeReason[ErrorCode.FS_WATCH_LIMIT_EXCEEDED]).toBe('fs.watch_limit_exceeded');
  });

  it('reserved codes are not redefined (40101, 50002 absent)', () => {
    const allValues = Object.values(ErrorCode);
    expect(allValues).not.toContain(40101); // auth.invalid_token (reserved)
    expect(allValues).not.toContain(40102); // auth.missing_token (reserved)
    expect(allValues).not.toContain(40103); // auth.forbidden_origin (reserved)
    expect(allValues).not.toContain(42901); // rate.limited (reserved)
    expect(allValues).not.toContain(50002); // protocol.version_mismatch (reserved)
  });

  it('ErrorCode type narrows to the literal union', () => {
    const code: ErrorCode = ErrorCode.SESSION_NOT_FOUND;
    // Type check at compile time; runtime sanity:
    const env: Envelope<null> = errEnvelope(code, 'x', 'req_t');
    expect(env.code).toBe(40401);
  });
});
