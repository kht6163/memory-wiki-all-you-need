import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { migrate } from "./schema.ts";

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
  /** Extra search words (synonyms, translations, spellings). Searched, never injected. */
  keywords: string[];
  /** Last day (YYYY-MM-DD) a temporary fact holds; after it the memory is no longer injected. */
  valid_until: string | null;
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
  /** Keywords at this revision (null for rows written before v0.6.0). */
  keywords: string[] | null;
  valid_until: string | null;
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
  /** Which client sent the turn ("claude-code"); absent for the pi extension, which never said. */
  agent?: string;
  /** The client's batch id (one turn per session and id; see enqueueTurn). */
  batch?: string;
}

export interface TurnResult {
  ops: unknown[];
  applied: { op: string; entryId: number; title: string }[];
  /** Ops dropped on purpose (e.g. an exact duplicate of an existing memory). */
  skipped?: { op: string; title: string; reason: string; entryId?: number }[];
  /** valid_until the worker took from a deadline written in the body (the LLM left it empty). */
  inferred?: { op: string; entryId: number; title: string; valid_until: string; from: "body" }[];
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
`);
{
  const applied = migrate(db);
  if (applied.length) console.log(`[db] schema migrated to version ${applied[applied.length - 1]} (steps ${applied.join(", ")})`);
}

// A crash mid-processing leaves turns stuck; put them back in the queue.
db.exec(`UPDATE turns SET status = 'pending' WHERE status = 'processing'`);
db.exec(`UPDATE wiki_jobs SET status = 'pending' WHERE status = 'processing'`);
db.exec(`UPDATE graph_jobs SET status = 'pending' WHERE status = 'processing'`);
db.exec(`UPDATE review_jobs SET status = 'pending' WHERE status = 'processing'`);

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
    keywords: JSON.parse(String(r.keywords ?? "[]")),
    valid_until: r.valid_until == null ? null : String(r.valid_until),
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
    keywords: r.keywords == null ? null : JSON.parse(String(r.keywords)),
    valid_until: r.valid_until == null ? null : String(r.valid_until),
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
