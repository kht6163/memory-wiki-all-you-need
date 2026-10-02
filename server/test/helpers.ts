// Shared helpers for server tests. Import AFTER setup.ts has run (it is loaded
// with --import, so a plain static import in a test file is fine).
import { api } from "../src/api.ts";
import { db } from "../src/db.ts";
import { runQueueOnce } from "../src/worker.ts";

export { llmCalls, llmDefault, llmReply, llmReset } from "./llm-stub.ts";
export { db, runQueueOnce };

/** Call the HTTP API in-process (no port). Returns status and parsed JSON. */
export async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await api.request(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, data: data as T };
}

/** call() that throws unless the status is 2xx. */
export async function ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await call<T>(method, path, body);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
}

/** Create (or fetch) a project the way the pi extension does, via /context. */
export async function project(key = "github.com/test/demo", name = "demo"): Promise<{ id: number; key: string; name: string }> {
  const r = await ok<{ project: { id: number; key: string; name: string } }>("POST", "/context", { project: { key, name }, prompt: "" });
  return r.project;
}

export interface NewEntry {
  scope?: "global" | "user" | "project";
  project_id?: number | null;
  category?: string;
  title: string;
  body?: string;
  tags?: string[];
  pinned?: boolean;
  entities?: (string | { name: string; kind?: string })[];
}

/** Create a memory as a human through the API. */
export async function entry(e: NewEntry): Promise<{ id: number; [k: string]: any }> {
  return ok("POST", "/entries", { scope: e.project_id ? "project" : "global", ...e });
}

/** Queue a turn like the pi extension does. */
export async function turn(messages: { role: "user" | "assistant" | "tool"; text: string; name?: string; toolCalls?: { name: string; args: string }[] }[], p?: { key: string; name: string } | null, sessionId = "s-1") {
  return ok<{ id: number }>("POST", "/turns", { sessionId, project: p ?? null, client: "test", cwd: "/tmp", messages });
}
