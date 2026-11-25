import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function buildSignatureHeader(
  secret: string,
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, rawBody)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Signature validity and freshness are two separate checks; both must pass.
 * The timestamp is inside the signed string so a captured request expires.
 */
export function verifySignature(input: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  toleranceSeconds?: number;
  now?: number;
}): VerifyResult {
  const { secret, header, rawBody, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS } = input;

  if (!header) return { ok: false, reason: 'missing signature header' };

  const parts = header.split(',').map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith('t='));
  const signaturePart = parts.find((part) => part.startsWith('v1='));
  if (!timestampPart || !signaturePart) return { ok: false, reason: 'malformed signature header' };

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'invalid timestamp' };

  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { ok: false, reason: `timestamp outside ${toleranceSeconds}s tolerance` };
  }

  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'hex');
  const received = Buffer.from(signaturePart.slice(3), 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true };
}
