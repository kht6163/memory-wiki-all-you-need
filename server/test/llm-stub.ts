// Fake OpenAI-compatible chat endpoint: intercepts fetch() to LLM_BASE_URL.
// Tests queue replies (objects are sent as the JSON message content) and can
// inspect every request the server made.

export interface LlmCall {
  system: string;
  user: string;
  body: Record<string, unknown>;
}

type Reply = unknown | ((call: LlmCall) => unknown);

const queue: Reply[] = [];
export const llmCalls: LlmCall[] = [];
let fallback: Reply | undefined;

/** Queue the next replies, in order. An Error instance makes that call fail with HTTP 500. */
export function llmReply(...replies: Reply[]) {
  queue.push(...replies);
}
/** Reply used when the queue is empty (default: an error, so unexpected calls are loud). */
export function llmDefault(reply: Reply | undefined) {
  fallback = reply;
}
export function llmReset() {
  queue.length = 0;
  llmCalls.length = 0;
  fallback = undefined;
}

export function installFakeLlm(baseUrl: string) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseUrl)) return real(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
    const call: LlmCall = {
      system: body.messages?.find((m) => m.role === "system")?.content ?? "",
      user: body.messages?.find((m) => m.role === "user")?.content ?? "",
      body: body as Record<string, unknown>,
    };
    llmCalls.push(call);
    let reply = queue.length ? queue.shift() : fallback;
    if (typeof reply === "function") reply = (reply as (c: LlmCall) => unknown)(call);
    if (reply === undefined) return new Response("no fake LLM reply queued", { status: 500 });
    if (reply instanceof Error) return new Response(reply.message, { status: 500 });
    const content = typeof reply === "string" ? reply : JSON.stringify(reply);
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  }) as typeof fetch;
}
