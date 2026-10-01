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

/** Accepts plain JSON, fenced JSON, or JSON surrounded by prose. */
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
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error(`LLM output is not JSON: ${trimmed.slice(0, 300)}`);
}
