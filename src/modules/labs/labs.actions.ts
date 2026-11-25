import type { ActionDefinition } from './labs.types.js';
import { dataActions } from './labs.actions.data.js';
import { eventActions } from './labs.actions.events.js';
import { runtimeActions } from './labs.actions.runtime.js';

const all: ActionDefinition[] = [...dataActions, ...eventActions, ...runtimeActions];

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
