import type { Request } from 'express';

/** `express.json({ verify })` stores the untouched bytes here. */
export type RawBodyRequest = Request & { rawBody?: Buffer };
