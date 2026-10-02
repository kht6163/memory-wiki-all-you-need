import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

export type Scope = "global" | "user" | "project";
export type Source = "agent" | "llm" | "human";

export const CATEGORIES = [
  "fact",
  "convention",
  "preference",
  "decision",
  "failure",
  "correction",
  "insight",
  "tool-quirk",
  "standing",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Project {
  id: number;
  key: string;
  name: string;
  remote: string | null;
  description: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export interface Entry {
  id: number;
  scope: Scope;
  project_id: number | null;
  category: Category;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  source: Source;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Revision {
  id: number;
  entry_id: number;
  action: "create" | "update" | "delete" | "restore";
  title: string;
  body: string;
  category: string;
  tags: string[];
  pinned: boolean;
  author: Source;
  turn_id: number | null;
  reason: string | null;
  /** Entity names at this revision (null for rows written before v0.4.0). */
  entities: string[] | null;
  created_at: string;
}

export type TurnStatus = "pending" | "processing" | "done" | "skipped" | "error";

export interface Turn {
  id: number;
  project_id: number | null;
  session_id: string;
  client: string | null;
  cwd: string | null;
  payload: TurnPayload;
  text: string;
  status: TurnStatus;
  error: string | null;
  result: TurnResult | null;
  created_at: string;
  processed_at: string | null;
}

export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: { name: string; args: string }[];
  name?: string;
  isError?: boolean;
}

export interface TurnPayload {
  messages: TurnMessage[];
}

export interface TurnResult {
  ops: unknown[];
  applied: { op: string; entryId: number; title: string }[];
  note?: string;
  model?: string;
  ms?: number;
}

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, "memory.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  remote TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','user','project')),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'fact',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS entries_scope ON entries(scope, project_id, deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body, tags, content='entries', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL,
  turn_id INTEGER REFERENCES turns(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS revisions_entry ON revisions(entry_id, id);
CREATE INDEX IF NOT EXISTS revisions_recent ON revisions(id DESC);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  client TEXT,
  cwd TEXT,
  payload TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS turns_status ON turns(status, id);
CREATE INDEX IF NOT EXISTS turns_project ON turns(project_id, id DESC);

-- Wiki: long-form pages written by people, by the agent (wiki_write) and by the
-- LLM when asked to compose pages from turn records. Independent of memory.
-- project_id NULL = the global wiki.
CREATE TABLE IF NOT EXISTS wiki_pages (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'llm',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_pages_slug ON wiki_pages(IFNULL(project_id, 0), slug);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  title, body, content='wiki_pages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS wiki_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS wiki_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS wiki_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO wiki_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS wiki_revisions (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  job_id INTEGER REFERENCES wiki_jobs(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS wiki_revisions_page ON wiki_revisions(page_id, id);

-- Derived on every page write: outgoing [[slug]] links and [#id] memory citations.
CREATE TABLE IF NOT EXISTS wiki_links (
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  to_slug TEXT NOT NULL,
  PRIMARY KEY (page_id, to_slug)
);
CREATE TABLE IF NOT EXISTS wiki_citations (
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL,
  PRIMARY KEY (page_id, entry_id)
);
CREATE INDEX IF NOT EXISTS wiki_citations_entry ON wiki_citations(entry_id);

-- Wiki work queue. kind 'compose' = the LLM organizes selected turn records
-- into pages. Only started on request (web UI, /wiki-compose); never automatic.
-- (v0.2.0 'write'/'sync' rows are kept as history only.)
CREATE TABLE IF NOT EXISTS wiki_jobs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  first_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  run_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS wiki_jobs_status ON wiki_jobs(status, run_after);

-- Which turns have been composed into which wiki (scope 0 = global wiki).
CREATE TABLE IF NOT EXISTS wiki_composed (
  scope INTEGER NOT NULL,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES wiki_jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, turn_id)
);

-- Memory graph. Entities (tech, services, tools, files, concepts) are shared
-- across projects; memories mention them, and memories link to each other
-- with a small set of typed relations. Edges of deleted memories are kept
-- (they come back on restore) but every query filters them out.
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'concept',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Other spellings that resolve to an entity (kept when entities are merged or renamed).
CREATE TABLE IF NOT EXISTS entity_aliases (
  norm TEXT PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS entry_entities (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, entity_id)
);
CREATE INDEX IF NOT EXISTS entry_entities_entity ON entry_entities(entity_id);
CREATE TABLE IF NOT EXISTS entry_links (
  from_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('depends_on','because','supersedes','related')),
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (from_id, to_id, type),
  CHECK (from_id != to_id)
);
CREATE INDEX IF NOT EXISTS entry_links_to ON entry_links(to_id);
-- Backfill queue: attach entities/links to existing memories (on request).
CREATE TABLE IF NOT EXISTS graph_jobs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);

-- How often a memory actually helped: recalled into a prompt, or returned to
-- the agent by memory_search / memory_graph. Drives the stable block's order
-- (recently used memories stay in) and the review job's stale detection.
CREATE TABLE IF NOT EXISTS entry_usage (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  recalled INTEGER NOT NULL DEFAULT 0,
  searched INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  -- Last day of use BEFORE the day of last_used_at. Ordering uses this for
  -- memories used today, so today's uses only take effect tomorrow.
  rank_day TEXT,
  -- Last time it was part of the stable block (recorded at most once a day).
  shown_at TEXT
);
-- Memory review: the LLM reads memories cluster by cluster and proposes merges,
-- fixes, deletions and conflicts. Nothing changes until a person applies one.
CREATE TABLE IF NOT EXISTS review_jobs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS review_proposals (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('merge','update','delete','conflict')),
  entry_ids TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed','stale')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS review_proposals_status ON review_proposals(status, job_id);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  text, content='turns', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`);

// A crash mid-processing leaves turns stuck; put them back in the queue.
db.exec(`UPDATE turns SET status = 'pending' WHERE status = 'processing'`);
db.exec(`UPDATE wiki_jobs SET status = 'pending' WHERE status = 'processing'`);
db.exec(`UPDATE graph_jobs SET status = 'pending' WHERE status = 'processing'`);
db.exec(`UPDATE review_jobs SET status = 'pending' WHERE status = 'processing'`);

// v0.4.0: revisions also snapshot the memory's entity names (NULL in older rows).
if (!db.prepare(`SELECT 1 FROM pragma_table_info('revisions') WHERE name = 'entities'`).get()) {
  db.exec(`ALTER TABLE revisions ADD COLUMN entities TEXT`);
}
// v0.2.0 memory→wiki write / wiki→memory sync jobs no longer exist.
db.exec(`UPDATE wiki_jobs SET status = 'skipped', error = 'removed in v0.3.0' WHERE status = 'pending' AND kind IN ('write','sync')`);

type Row = Record<string, unknown>;

export function now(): string {
  return new Date().toISOString();
}

export function rowToEntry(r: Row): Entry {
  return {
    id: Number(r.id),
    scope: r.scope as Scope,
    project_id: r.project_id == null ? null : Number(r.project_id),
    category: r.category as Category,
    title: String(r.title),
    body: String(r.body),
    tags: JSON.parse(String(r.tags ?? "[]")),
    pinned: Boolean(r.pinned),
    source: r.source as Source,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    deleted_at: r.deleted_at == null ? null : String(r.deleted_at),
  };
}

export function rowToRevision(r: Row): Revision {
  return {
    id: Number(r.id),
    entry_id: Number(r.entry_id),
    action: r.action as Revision["action"],
    title: String(r.title),
    body: String(r.body),
    category: String(r.category),
    tags: JSON.parse(String(r.tags ?? "[]")),
    pinned: Boolean(r.pinned),
    author: r.author as Source,
    turn_id: r.turn_id == null ? null : Number(r.turn_id),
    reason: r.reason == null ? null : String(r.reason),
    entities: r.entities == null ? null : JSON.parse(String(r.entities)),
    created_at: String(r.created_at),
  };
}

export function rowToTurn(r: Row): Turn {
  return {
    id: Number(r.id),
    project_id: r.project_id == null ? null : Number(r.project_id),
    session_id: String(r.session_id),
    client: r.client == null ? null : String(r.client),
    cwd: r.cwd == null ? null : String(r.cwd),
    payload: JSON.parse(String(r.payload)),
    text: String(r.text ?? ""),
    status: r.status as TurnStatus,
    error: r.error == null ? null : String(r.error),
    result: r.result == null ? null : JSON.parse(String(r.result)),
    created_at: String(r.created_at),
    processed_at: r.processed_at == null ? null : String(r.processed_at),
  };
}

export function rowToProject(r: Row): Project {
  return {
    id: Number(r.id),
    key: String(r.key),
    name: String(r.name),
    remote: r.remote == null ? null : String(r.remote),
    description: String(r.description ?? ""),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_seen_at: r.last_seen_at == null ? null : String(r.last_seen_at),
  };
}

let txDepth = 0;
/** Runs fn in one transaction; nested calls join the outer one. */
export function transaction<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  txDepth++;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    txDepth--;
  }
}
