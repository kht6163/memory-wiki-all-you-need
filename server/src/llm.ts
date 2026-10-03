import { config } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatJson(messages: ChatMessage[]): Promise<{ data: unknown; raw: string }> {
  const ctrl = AbortSignal.timeout(config.llm.timeoutMs);
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    signal: ctrl,
    headers: {
      "content-type": "application/json",
      ...(config.llm.apiKey ? { authorization: `Bearer ${config.llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  let raw: string;
  try {
    raw = JSON.parse(text).choices?.[0]?.message?.content ?? "";
  } catch {
    throw new Error(`LLM returned non-JSON envelope: ${text.slice(0, 300)}`);
  }
  return { data: parseLooseJson(raw), raw };
}

/** The model's reply could not be read as JSON (a retry may help, unlike an HTTP or timeout error). */
export class LlmJsonError extends Error {}

/** Accepts plain JSON, fenced JSON, or JSON surrounded by prose or trailing garbage. */
export function parseLooseJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }
  // The first complete top-level object, so trailing garbage (an extra "]}") is ignored.
  // A balanced span that is not JSON is skipped only when it is prose in braces ("{note}");
  // one that opens like a JSON object ('{"') is a broken reply, so stop: never parse an object
  // nested in it (or after its stray "}") as if it were the reply.
  for (let start = trimmed.indexOf("{"), tries = 0; start >= 0 && tries < 20; tries++) {
    const end = objectEnd(trimmed, start);
    if (end < 0) break;
    const span = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(span);
    } catch {
      if (/^\{\s*"/.test(span)) break;
      start = trimmed.indexOf("{", end + 1);
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new LlmJsonError(`LLM output is not JSON: ${trimmed.slice(0, 300)}`);
}

/** Index of the "}" closing the object that opens at `start` (string-aware), or -1. */
function objectEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
