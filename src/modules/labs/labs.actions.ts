import type { ActionDefinition } from './labs.types.js';
import { dataActions } from './labs.actions.data.js';
import { eventActions } from './labs.actions.events.js';
import { logActions } from './labs.actions.logs.js';
import { middlewareActions } from './labs.actions.middleware.js';
import { runtimeActions } from './labs.actions.runtime.js';
import { webhookActions } from './labs.actions.webhooks.js';
import { capstoneActions } from './labs.actions.capstone.js';
import { concurrencyActions } from './labs.actions.concurrency.js';

const all: ActionDefinition[] = [
  ...dataActions,
  ...eventActions,
  ...logActions,
  ...middlewareActions,
  ...runtimeActions,
  ...webhookActions,
  ...concurrencyActions,
  ...capstoneActions,
];

const byId = new Map<string, ActionDefinition>();

for (const action of all) {
  if (byId.has(action.id)) throw new Error(`duplicate lab action id: ${action.id}`);
  byId.set(action.id, action);
}

export const labActions: readonly ActionDefinition[] = all;

export function getLabAction(id: string): ActionDefinition | undefined {
  return byId.get(id);
}

export function actionsForTopic(topicId: string): ActionDefinition[] {
  return all.filter((action) => action.topicId === topicId);
}
