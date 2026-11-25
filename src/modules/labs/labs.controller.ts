import type { RequestHandler } from 'express';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { topics } from './labs.topics.js';
import { glossaryByArea } from './labs.glossary.js';
import { actionsForTopic, getLabAction } from './labs.actions.js';
import type { ActionResult, LabTopic } from './labs.types.js';

export type LabsController = {
  listTopics: RequestHandler;
  listGlossary: RequestHandler;
  runAction: RequestHandler;
  probeError: RequestHandler;
};

function withActions(topic: LabTopic): LabTopic {
  const registered = actionsForTopic(topic.id);
  return {
    ...topic,
    actions: topic.actions.map((ref) => {
      const match = registered.find((action) => action.id === ref.id);
      return {
        id: ref.id,
        label: match?.label ?? ref.label,
        description: ref.description,
      };
    }),
  };
}

export function createLabsController(): LabsController {
  return {
    listTopics: (async (_req, res) => {
      // No timestamp here on purpose: a volatile field would change the ETag
      // on every request and defeat conditional polling.
      res.json({ topics: topics.map(withActions) });
    }) satisfies RequestHandler,

    listGlossary: (async (_req, res) => {
      res.json({ groups: glossaryByArea() });
    }) satisfies RequestHandler,

    runAction: (async (req, res) => {
      const raw = req.params.actionId;
      const actionId = Array.isArray(raw) ? raw[0] : raw;
      if (!actionId) throw new ValidationError('Missing actionId');

      const action = getLabAction(actionId);
      if (!action) throw new NotFoundError(`Unknown lab action: ${actionId}`);

      const started = Date.now();
      const data: ActionResult = await action.run(req.body);

      res.json({
        actionId: action.id,
        topicId: action.topicId,
        heavy: Boolean(action.heavy),
        durationMs: Date.now() - started,
        data,
      });
    }) satisfies RequestHandler,

    probeError: (async () => {
      throw new ConflictError('This 409 was created by the labs error-contract probe', {
        probe: 'middleware.error-contract',
        hint: 'The response body is the error serializer output',
      });
    }) satisfies RequestHandler,
  };
}
