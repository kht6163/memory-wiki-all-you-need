// Fake OpenAI-compatible /embeddings endpoint: intercepts fetch() to the embed
// test URL. Vectors are deterministic: one dimension per "concept" (a group of
// words meaning the same thing in several languages) plus a weak hash of the
// characters, so same-meaning texts in different languages are close and
// unrelated texts are far — what a multilingual model does, without one.

export const EMBED_TEST_URL = "http://embed.test/v1";

const CONCEPTS: string[][] = [
  ["deploy", "배포", "デプロイ", "ship to production", "운영에 올리"],
  ["port", "포트", "ポート", "listens on"],
  ["database", "데이터베이스", "sqlite", "db"],
  ["weather", "날씨", "天気"],
  ["timezone", "시간대", "time zone"],
];
const NOISE_DIMS = 32;

export interface EmbedCall {
  input: string[];
  model: string;
}
export const embedCalls: EmbedCall[] = [];
type Mode = "ok" | "error" | "hang" | ((input: string[]) => Response | undefined);
let mode: Mode = "ok";

/** "error": HTTP 500; "hang": never answers (until the caller's timeout); a function may answer per request. */
export function embedMode(m: Mode) {
  mode = m;
}
export function embedReset() {
  embedCalls.length = 0;
  mode = "ok";
}

export function fakeVector(text: string): number[] {
  const t = text.toLowerCase();
  const v = new Array(CONCEPTS.length + NOISE_DIMS).fill(0);
  CONCEPTS.forEach((words, i) => {
    if (words.some((w) => t.includes(w))) v[i] = 1;
  });
  // Signed, so two texts sharing no concept are near orthogonal (cosine ~0), not alike.
  for (let i = 0; i + 1 < t.length; i++) {
    const h = t.charCodeAt(i) * 31 + t.charCodeAt(i + 1);
    v[CONCEPTS.length + (h % NOISE_DIMS)] += (h >> 5) % 2 ? 0.03 : -0.03;
  }
  return v;
}

export function installFakeEmbeddings(baseUrl = EMBED_TEST_URL) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseUrl)) return real(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[]; model: string };
    const texts = Array.isArray(body.input) ? body.input : [body.input];
    embedCalls.push({ input: texts, model: body.model });
    if (mode === "error") return new Response("embedder down", { status: 500 });
    if (mode === "hang")
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        s?.addEventListener("abort", () => reject(s.reason));
      });
    if (typeof mode === "function") {
      const r = mode(texts);
      if (r) return r;
    }
    return Response.json({ object: "list", model: body.model, data: texts.map((t, index) => ({ object: "embedding", index, embedding: fakeVector(t) })) });
  }) as typeof fetch;
}
