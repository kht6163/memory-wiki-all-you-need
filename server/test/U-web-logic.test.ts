// Web UI pure logic (web/src/*.ts without DOM/React): Korean error messages, editor-preview missing
// links, review proposal edits/entities. The server is not involved; these run here because web/
// has no test runner of its own.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError, describeError, errorText } from "../../web/src/errors.ts";
import { missingLinks, slugify } from "../../web/src/wikilinks.ts";
import { editProblems, entityChange, entityKey, proposalEdits } from "../../web/src/proposal.ts";
import { entityNorm } from "../src/entities.ts";

const hangul = /[가-힣]/;

test("G-048: graph revert 409 messages are shown in Korean", () => {
  const cases: [number, string, RegExp][] = [
    [400, "every turn is already composed into this wiki", /이미 이 위키에 정리/],
    [400, "this session has no recorded turns yet", /기록된 턴이 없습니다/],
    [409, "the merge target #12 no longer exists — restore the target first", /#12.*되살리세요/],
    [409, "nothing to revert: the entity already has these values", /되돌릴 것이 없습니다/],
    [409, '"Redis" is now entity #7 — merge instead', /"Redis".*#7.*합치기/],
    [409, '"Redis" is already entity #7 — merge instead', /"Redis".*#7/],
    [409, 'a link "add" cannot be reverted', /관계 추가 변경은 되돌릴 수 없습니다/],
    [409, "this change was already reverted", /이미 되돌린/],
    [409, "memory #5 was permanently deleted — this link cannot be restored", /메모리 #5.*영구 삭제.*되살릴 수 없습니다/],
    [409, "memory #5 is now a different memory (the original was permanently deleted) — this link cannot be restored", /메모리 #5.*다른 메모리.*되살릴 수 없습니다/],
    [409, '"k8s" now resolves to entity #3 — revert that change first', /#3.*먼저 되돌리세요/],
    [409, "#4 already supersedes #9 (directly or through others)", /#4.*#9.*순환/],
    [400, "a project memory can only supersede memories of the same project", /같은 프로젝트의 메모리만/],
    [409, "proposal is already applied", /이미 적용된 제안/],
    [409, "the memories changed since this was proposed; run the review again", /제안 뒤 메모리가 바뀌었습니다/],
    [422, "the edited passage is no longer in the body", /본문에 없습니다/],
    [422, "the edited passage now occurs more than once", /여러 번/],
    [422, "could not apply: the edited passages now overlap", /^제안을 적용하지 못했습니다: .*겹칩니다/],
    [422, "could not apply: the proposed entities are no longer on the memory", /^제안을 적용하지 못했습니다: 제안한 엔티티/],
    [404, "entry not found", /^메모리를 찾을 수 없습니다$/],
    [400, "title is too long (max 200)", /제목이 너무 깁니다 \(최대 200자\)/],
  ];
  for (const [status, msg, want] of cases) {
    const d = describeError(new ApiError(status, msg));
    assert.equal(d.known, true, msg);
    assert.match(d.text, want, msg);
    assert.equal(d.raw, msg);
  }
});

test("G-048: review apply 422 wrapping translates the inner message", () => {
  const d = describeError(new ApiError(422, "could not apply: content looks like it contains secrets: openai-key"));
  assert.equal(d.known, true);
  assert.match(d.text, /^제안을 적용하지 못했습니다: 비밀값.*openai-key/);
  const u = describeError(new ApiError(422, "could not apply: something new"));
  assert.equal(u.known, false);
  assert.equal(u.text, "제안을 적용하지 못했습니다");
});

test("G-048: unknown messages fall back to Korean by status and keep the raw text", () => {
  const d = describeError(new ApiError(409, "edits[1] overlaps edits[0]"));
  assert.equal(d.known, false);
  assert.match(d.text, hangul);
  assert.equal(d.raw, "edits[1] overlaps edits[0]");
  assert.equal(errorText(new ApiError(409, "edits[1] overlaps edits[0]")), `${d.text} (edits[1] overlaps edits[0])`);
  assert.match(describeError(new ApiError(502, "HTTP 502")).text, /서버 오류/);
  assert.match(describeError(new TypeError("Failed to fetch")).text, /서버에 연결할 수 없습니다/);
  assert.match(describeError("weird").text, hangul);
});

/** Top-level ${…} spans of a template literal body replaced by "7" (nested templates included). */
function sampleTemplate(src: string, start: number): { text: string; end: number } {
  let out = "";
  let i = start;
  while (src[i] !== "`") {
    if (src[i] === "\\") {
      out += src[i + 1];
      i += 2;
    } else if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (depth) {
        if (src[i] === "`") i = sampleTemplate(src, i + 1).end;
        else if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      out += "7";
    } else out += src[i++];
  }
  return { text: out, end: i };
}

// Agent-facing messages (pi memory tool, wiki tool, install script): the web UI never shows them.
const AGENT_ONLY = [/^old_text is required$/, /^action must be add, replace or remove$/, /^no 7 memory contains/, /^"7" matches 7 memories/, /^unknown project 7/, /^no wiki page "7"/];

test("G-048: every 4xx HttpError message in server/src has a Korean rule", () => {
  // Static messages are checked as written; template messages with every ${…} replaced by "7".
  // "could not apply: …" wraps another message and is covered by its own test.
  const files = ["api.ts", "graph.ts", "graph-revisions.ts", "review.ts", "wiki.ts", "store.ts", "turns.ts", "entity-similar.ts"];
  const untranslated: string[] = [];
  let templates = 0;
  for (const f of files) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const msgs: string[] = [];
    for (const m of src.matchAll(/HttpError\(4\d\d, "([^"]*)"\)/g)) msgs.push(m[1]);
    for (const m of src.matchAll(/HttpError\(4\d\d, `/g)) {
      msgs.push(sampleTemplate(src, m.index + m[0].length).text);
      templates++;
    }
    // Revert blocks (graph-revisions.ts) carry the message the revert throws (G-041).
    if (f === "graph-revisions.ts") {
      for (const m of src.matchAll(/message: "([^"]*)"/g)) msgs.push(m[1]);
      for (const m of src.matchAll(/message: `/g)) msgs.push(sampleTemplate(src, m.index + m[0].length).text);
    }
    for (const msg of msgs) {
      if (msg.startsWith("could not apply: ") || AGENT_ONLY.some((re) => re.test(msg))) continue;
      if (!describeError(new ApiError(409, msg)).known) untranslated.push(`${f}: ${msg}`);
    }
  }
  assert.ok(templates > 10, "template messages were found");
  assert.deepEqual(untranslated, []);
});

test("web-ui: editor preview marks links to pages that do not exist", () => {
  const body = "See [[Setup Guide]], [[existing|label]], [[existing#section]], [[global:Other]] and [[self]].";
  const m = missingLinks(body, 3, ["existing"], "self");
  assert.deepEqual([...m].sort(), [slugify("Setup Guide")]);
  // In the global wiki (scope 0) a global: target is the own wiki.
  const g = missingLinks(body, 0, ["existing"], "self");
  assert.deepEqual([...g].sort(), ["other", "setup-guide"]);
});

test("G-045: update proposals read data.edits and still the legacy data.edit", () => {
  assert.deepEqual(proposalEdits({ edits: [{ old: "a", new: "b" }, { old: "c", new: "d" }] }), [
    { old: "a", new: "b" },
    { old: "c", new: "d" },
  ]);
  assert.deepEqual(proposalEdits({ edit: { old: "x", new: "y" } }), [{ old: "x", new: "y" }]);
  assert.deepEqual(proposalEdits({}), []);
});

test("G-045: edit warnings — missing, repeated, overlapping passages", () => {
  const body = "alpha beta gamma beta";
  assert.deepEqual(
    editProblems(body, [
      { old: "alpha", new: "A" },
      { old: "beta", new: "B" },
      { old: "zeta", new: "Z" },
    ]),
    [null, "repeated", "missing"],
  );
  assert.deepEqual(
    editProblems(body, [
      { old: "alpha beta", new: "x" },
      { old: "beta gamma", new: "y" },
    ]),
    ["overlap", "overlap"],
  );
  assert.deepEqual(editProblems(body, [{ old: "", new: "x" }]), ["missing"]);
});

test("G-046: entity change shows removed names and flags names outside the current list", () => {
  assert.equal(entityChange(["Redis", "Docker"], undefined), null);
  assert.equal(entityChange(["Redis", "Docker"], ["docker", "redis"]), null);
  assert.deepEqual(entityChange(["Redis", "Docker"], ["Redis"]), { kept: ["Redis"], removed: ["Docker"], added: [] });
  assert.deepEqual(entityChange(["Redis"], ["Redis", "Kafka"]), { kept: ["Redis"], removed: [], added: ["Kafka"] });
});

test("G-046: entity names are matched like the server's entityNorm", () => {
  assert.equal(entityChange(["Node.js"], ["nodejs"]), null);
  assert.equal(entityChange(["PostgreSQL 16", "src / api/"], ["postgresql", "./src/api"]), null);
  assert.deepEqual(entityChange(["k8s/"], ["k8s"]), { kept: [], removed: ["k8s/"], added: ["k8s"] });
  for (const n of ["Node.js", "node_js", " Redis  7.2 ", "./src//api/", "k8s/", "src/api/", "Ｆｕｌｌ－ｗｉｄｔｈ", "a-b c.d_e", "v2"]) {
    assert.equal(entityKey(n), entityNorm(n), n);
  }
});

// CSS tokens (G-037, removed v0.5 aliases): undefined var(--x) is silently ignored by browsers,
// so neither tsc nor vite catches these.
const webSrc = new URL("../../web/src/", import.meta.url);
const styles = readFileSync(new URL("styles.css", webSrc), "utf8");

function darkBlock(open: string): string[] {
  const at = styles.indexOf(open);
  assert.ok(at >= 0, open);
  let depth = 0;
  let i = styles.indexOf("{", at);
  const from = i;
  do {
    if (styles[i] === "{") depth++;
    else if (styles[i] === "}") depth--;
    i++;
  } while (depth);
  return [...styles.slice(from, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => `${m[1]}: ${m[2].trim()}`).sort();
}

test("G-037: the two dark-theme token blocks in styles.css are identical", () => {
  const media = darkBlock("@media (prefers-color-scheme: dark)");
  const attr = darkBlock(':root[data-theme="dark"]');
  assert.ok(media.length > 10);
  assert.deepEqual(media, attr);
});

test("G-037: every var(--name) used in web/src is defined in some stylesheet", () => {
  const files = readdirSync(webSrc, { recursive: true, encoding: "utf8" }).filter((f) => /\.(css|tsx?)$/.test(f));
  const sources = files.map((f) => [f, readFileSync(new URL(f, webSrc), "utf8")] as const);
  const defined = new Set<string>();
  for (const [f, src] of sources) if (f.endsWith(".css")) for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  const missing: string[] = [];
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
      // --c-<category> is built from data at runtime (`var(--c-${category})`).
      if (!defined.has(m[1]) && !m[1].startsWith("--c-")) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
