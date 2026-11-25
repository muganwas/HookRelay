import type { RequestHandler } from 'express';
import { NotFoundError } from '../../shared/errors.js';
import { getDeliveryView, isTerminal, listAttempts } from './delivery.service.js';

const MAX_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 150;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export type DeliveryController = {
  get: RequestHandler;
  attempts: RequestHandler;
};

export function createDeliveryController(): DeliveryController {
  return {
    get: (async (req, res) => {
      const id = param(req.params.id);
      const requestedWait = Number(req.query.wait ?? 0);
      const wait = Number.isFinite(requestedWait)
        ? Math.min(MAX_WAIT_SECONDS, Math.max(0, requestedWait))
        : 0;

      let view = await getDeliveryView(id);
      if (!view) throw new NotFoundError(`Delivery ${id} not found`);

      // Long-poll: hold the request until the delivery is terminal or the
      // bounded wait expires. A bounded wait is what stops sockets piling up.
      if (wait > 0 && !isTerminal(view.status)) {
        const deadline = Date.now() + wait * 1000;
        while (!isTerminal(view.status) && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          const next = await getDeliveryView(id);
          if (!next) break;
          view = next;
        }
      }

      res.json(view);
    }) satisfies RequestHandler,

    attempts: (async (req, res) => {
      const id = param(req.params.id);
      const view = await getDeliveryView(id);
      if (!view) throw new NotFoundError(`Delivery ${id} not found`);

      res.json({ deliveryId: id, attempts: await listAttempts(id) });
    }) satisfies RequestHandler,
  };
}
