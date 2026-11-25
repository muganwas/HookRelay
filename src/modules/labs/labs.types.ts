export type SnippetLanguage = 'ts' | 'sql' | 'bash' | 'yaml' | 'json' | 'http';

export type Snippet = {
  label: string;
  language: SnippetLanguage;
  code: string;
};

export type LabActionRef = {
  id: string;
  label: string;
  description: string;
};

export type LabTopic = {
  id: string;
  order: number;
  phase: string;
  title: string;
  status: 'live' | 'reference';
  summary: string;
  keyIdeas: string[];
  interviewQuestions: string[];
  snippets: Snippet[];
  actions: LabActionRef[];
};

export type ResultTable = {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
};

export type ActionResult = {
  title: string;
  summary: string;
  table?: ResultTable;
  sql?: string;
  notes?: string[];
  raw?: unknown;
};

export type ActionDefinition = {
  id: string;
  label: string;
  topicId: string;
  heavy?: boolean;
  requires?: string[];
  run: (input: unknown) => Promise<ActionResult>;
};
