import { ADVERTISED_REQUIRED_METHODS } from "../handshake";

/** §5.5 typed decline for an unknown or known-unimplemented reverse request. */
export function typedDeclineResult(): { ok: false } {
  return { ok: false };
}

/**
 * Answer shape for an unknown reverse with `id`.
 * `-32601` only when the client advertised the method as required.
 */
export function unknownReverseAnswer(method: string): {
  result?: { ok: false };
  error?: { code: number; message: string };
} {
  if (ADVERTISED_REQUIRED_METHODS.includes(method)) {
    return { error: { code: -32601, message: `Unsupported method: ${method}` } };
  }
  return { result: typedDeclineResult() };
}
