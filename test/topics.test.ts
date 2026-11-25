import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { topics, getTopic } from '../src/modules/labs/labs.topics.js';
import { actionsForTopic, getLabAction, labActions } from '../src/modules/labs/labs.actions.js';
import { areaLabels, glossary, glossaryByArea } from '../src/modules/labs/labs.glossary.js';
import { closeResources } from './helpers.js';

after(closeResources);

describe('topic catalogue', () => {
  it('covers every phase of the study plan', () => {
    assert.ok(topics.length >= 13, `expected at least 13 topics, got ${topics.length}`);
  });

  it('has unique ids and unique order values', () => {
    const ids = topics.map((t) => t.id);
    const orders = topics.map((t) => t.order);
    assert.equal(new Set(ids).size, ids.length, 'duplicate topic id');
    assert.equal(new Set(orders).size, orders.length, 'duplicate topic order');
  });

  it('uses stable kebab-case ids', () => {
    for (const topic of topics) {
      assert.match(topic.id, /^[a-z][a-z0-9-]*$/, `bad id: ${topic.id}`);
      assert.match(topic.phase, /\d+/, `bad phase: ${topic.phase}`);
    }
  });

  it('gives every topic substance', () => {
    for (const topic of topics) {
      assert.ok(topic.title.length > 2, `${topic.id} has no title`);
      assert.ok(topic.summary.length > 20, `${topic.id} has a thin summary`);
      assert.ok(topic.keyIdeas.length >= 4, `${topic.id} needs at least 4 key ideas`);
      assert.ok(topic.interviewQuestions.length >= 3, `${topic.id} needs interview questions`);
      assert.ok(topic.snippets.length >= 1, `${topic.id} needs a snippet`);
    }
  });

  it('has non-empty snippet code with unique labels per topic', () => {
    for (const topic of topics) {
      const labels = topic.snippets.map((s) => s.label);
      assert.equal(new Set(labels).size, labels.length, `${topic.id} has duplicate snippet labels`);

      for (const snippet of topic.snippets) {
        assert.ok(snippet.code.trim().length > 10, `${topic.id}/${snippet.label} code is empty`);
        assert.ok(
          !snippet.code.includes('TODO'),
          `${topic.id}/${snippet.label} still contains a TODO`,
        );
      }
    }
  });
});

describe('glossary', () => {
  it('explains every entry with an expansion and a plain-language sentence', () => {
    for (const entry of glossary) {
      assert.ok(entry.term.length > 1, 'entry without a term');
      assert.ok(entry.full.length > 1, `${entry.term} has no expansion`);
      assert.ok(entry.plain.length > 20, `${entry.term} has no plain-language explanation`);
      assert.ok(areaLabels[entry.area], `${entry.term} points at unknown area ${entry.area}`);
    }
  });

  it('has no duplicate terms or aliases', () => {
    const forms = glossary.flatMap((entry) => [entry.term, ...(entry.match ?? [])]);
    const lowered = forms.map((form) => form.toLowerCase());

    assert.equal(new Set(lowered).size, lowered.length, 'two entries claim the same spelling');
  });

  it('groups every entry under a labelled area', () => {
    const grouped = glossaryByArea();

    assert.deepEqual(
      grouped.map((group) => group.area),
      ['web', 'node', 'postgres', 'queues', 'caching', 'ops', 'git'],
    );
    assert.equal(
      grouped.reduce((total, group) => total + group.entries.length, 0),
      glossary.length,
    );
    for (const group of grouped) {
      assert.equal(group.label, areaLabels[group.area]);
    }
  });

  it('covers the abbreviations the lab prose actually uses', () => {
    const required = ['TTL', 'HMAC', 'ETag', 'UUID', 'FK', 'PK', 'SLO', 'PR', 'CI', 'MVCC'];
    const terms = new Set(
      glossary.flatMap((entry) => [entry.term, ...(entry.match ?? [])]).map((form) => form.toUpperCase()),
    );

    for (const term of required) {
      assert.ok(terms.has(term.toUpperCase()), `glossary is missing ${term}`);
    }
  });

  it('only links terms that appear in the lab content', () => {
    const haystack = topics
      .flatMap((topic) => [
        topic.title,
        topic.summary,
        ...topic.keyIdeas,
        ...topic.interviewQuestions,
        ...topic.snippets.map((snippet) => snippet.label),
        ...topic.actions.flatMap((action) => [action.label, action.description]),
      ])
      .join('\n')
      .toLowerCase();

    for (const entry of glossary) {
      if (entry.autoLink === false) continue;
      const forms = [entry.term, ...(entry.match ?? [])].map((form) => form.toLowerCase());
      assert.ok(
        forms.some((form) => haystack.includes(form)),
        `${entry.term} is never mentioned in the labs, so linking it is noise`,
      );
    }
  });
});

describe('action registry', () => {
  it('has no duplicate action ids', () => {
    const ids = labActions.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('resolves every registered action by id', () => {
    for (const action of labActions) {
      assert.equal(getLabAction(action.id)?.id, action.id);
    }
  });

  it('binds every action to an existing topic', () => {
    for (const action of labActions) {
      assert.ok(getTopic(action.topicId), `${action.id} points at unknown topic ${action.topicId}`);
    }
  });

  it('references only actions that exist', () => {
    for (const topic of topics) {
      for (const ref of topic.actions) {
        assert.ok(
          getLabAction(ref.id),
          `${topic.id} references missing action ${ref.id}`,
        );
      }
    }
  });

  it('exposes every registered action from its topic', () => {
    for (const action of labActions) {
      const topic = getTopic(action.topicId);
      assert.ok(topic, `${action.id} has no topic`);
      const referenced = topic.actions.some((ref) => ref.id === action.id);
      assert.ok(referenced, `${action.id} is registered but not listed on ${topic.id}`);
    }
  });

  it('matches actionsForTopic to the topic manifest', () => {
    for (const topic of topics) {
      const registered = actionsForTopic(topic.id).map((a) => a.id).sort();
      const declared = topic.actions.map((a) => a.id).sort();
      assert.deepEqual(registered, declared, `${topic.id} manifest disagrees with registry`);
    }
  });

  it('keeps reference topics free of demos', () => {
    for (const topic of topics) {
      if (topic.status === 'reference') {
        assert.equal(topic.actions.length, 0, `${topic.id} is reference but has demos`);
      } else {
        assert.ok(topic.actions.length > 0, `${topic.id} is live but has no demo`);
      }
    }
  });

  it('marks heavy actions so the UI can warn', () => {
    const heavy = labActions.filter((a) => a.heavy).map((a) => a.id);
    assert.deepEqual(heavy.sort(), [
      'capstone.load',
      'capstone.pool',
      'capstone.slow-receiver',
      'indexes.before-after',
      'indexes.seed',
    ]);
  });
});
