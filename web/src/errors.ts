// Server error messages are English (agents read them too); the web UI shows them in Korean.
// Pure module (no DOM, no React) so server/test can import it.

/** Thrown by api.ts request(): keeps the HTTP status next to the server's message. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ErrorText {
  /** Korean text for the user. */
  text: string;
  /** The original message (English from the server), for small print or a tooltip. */
  raw: string;
  /** True when a rule translated the message; false for the generic fallback. */
  known: boolean;
}

/** Object forms (with 을/를) of the not-found nouns. */
const NOUN: Record<string, string> = {
  entry: "메모리를",
  page: "페이지를",
  project: "프로젝트를",
  entity: "엔티티를",
  revision: "변경 이력을",
  job: "작업을",
  proposal: "제안을",
  turn: "턴을",
};
const FIELD: Record<string, string> = { title: "제목이", body: "본문이", description: "설명이", policy: "정리 방침이" };
const TARGET: Record<string, string> = { link: "관계", entity: "엔티티" };
const ACTION: Record<string, string> = { add: "추가", remove: "삭제", update: "수정", merge: "합치기", delete: "삭제", create: "추가" };
const PROPOSAL_STATUS: Record<string, string> = { applied: "적용된", dismissed: "무시된", stale: "낡은", pending: "대기 중인" };

type Rule = [RegExp, (...m: string[]) => string];

// Ordered: first match wins. Patterns follow the HttpError(4xx, …) messages in server/src/*.ts.
const RULES: Rule[] = [
  // wiki compose
  [/^this session has no recorded turns yet$/, () => "이 세션에는 아직 기록된 턴이 없습니다"],
  [/^every turn is already composed into this wiki$/, () => "모든 턴이 이미 이 위키에 정리되었습니다"],
  // graph revisions (revert)
  [/^this change was already reverted$/, () => "이미 되돌린 변경입니다"],
  [/^a (\w+) "(\w+)" cannot be reverted$/, (t, a) => `${TARGET[t] ?? t} ${ACTION[a] ?? a} 변경은 되돌릴 수 없습니다`],
  [/^the link already exists$/, () => "같은 관계가 이미 있습니다"],
  [/^the link no longer exists$/, () => "그 관계가 이제 없습니다. 되돌릴 수 없습니다"],
  [/^the link no longer retires its target$/, () => "그 관계가 더 이상 대상을 대체하지 않습니다"],
  [/^"(.+)" is (?:already|now) entity #(\d+) — merge instead$/, (n, id) => `"${n}"은(는) 이미 엔티티 #${id}입니다 — 대신 합치기를 쓰세요`],
  [/^nothing to revert/, () => "되돌릴 것이 없습니다: 엔티티가 이미 그 값입니다"],
  [/^the merge target #(\d+) no longer exists — restore the target first$/, (id) => `합친 대상 #${id}이(가) 이제 없습니다 — 먼저 대상을 되살리세요`],
  [/^memory #(\d+) was permanently deleted — this link cannot be restored$/, (id) => `메모리 #${id}이(가) 영구 삭제되어 이 관계를 되살릴 수 없습니다`],
  [/^memory #(\d+) is now a different memory .* — this link cannot be restored$/, (id) => `메모리 #${id}은(는) 이제 다른 메모리입니다(원래 메모리는 영구 삭제됨) — 이 관계를 되살릴 수 없습니다`],
  [/^"(.+)" now resolves to entity #(\d+) — revert that change first$/, (n, id) => `"${n}"은(는) 이제 엔티티 #${id}을(를) 가리킵니다 — 그 변경을 먼저 되돌리세요`],
  // links
  [/^#(\d+) already supersedes #(\d+)/, (a, b) => `#${a}이(가) 이미 #${b}을(를) 대체합니다(직접 또는 다른 메모리를 거쳐) — 순환이 생깁니다`],
  [/^a memory cannot link to itself$/, () => "메모리를 자기 자신과 연결할 수 없습니다"],
  [/^a project memory can only supersede memories of the same project$/, () => "프로젝트 메모리는 같은 프로젝트의 메모리만 대체할 수 있습니다"],
  [/^both memories must exist$/, () => "두 메모리가 모두 있어야 합니다"],
  [/^(?:invalid link type|link type must be one of)/, () => "관계 종류가 올바르지 않습니다"],
  // entities
  [/^cannot merge an entity into itself$/, () => "엔티티를 자기 자신에 합칠 수 없습니다"],
  [/^a and b must be different entities$/, () => "서로 다른 두 엔티티를 골라야 합니다"],
  [/^a and b must be entity ids$/, () => "엔티티 id가 올바르지 않습니다"],
  [/^name is required$/, () => "이름을 입력하세요"],
  [/^kind must be one of/, () => "엔티티 종류가 올바르지 않습니다"],
  [/^no entity "(.+?)"/, (n) => `"${n}" 엔티티가 없습니다`],
  // jobs
  [/^only queued or running jobs can be cancelled$/, () => "대기 중이거나 진행 중인 작업만 취소할 수 있습니다"],
  [/^only failed or cancelled jobs can be retried$/, () => "실패했거나 취소된 작업만 다시 실행할 수 있습니다"],
  [/^job is still stopping/, () => "작업이 아직 멈추는 중입니다. 잠시 뒤 다시 시도하세요"],
  [/^job is running$/, () => "작업이 진행 중입니다"],
  [/^turn is being processed$/, () => "턴을 처리하는 중입니다"],
  [/^(?:sessionId|project key) is required$/, () => "필수 값이 빠졌습니다"],
  [/^messages must be an array$|^turn has no messages$/, () => "턴 기록이 올바르지 않습니다"],
  // review
  [/^a review of this scope is already running$/, () => "이 범위의 점검이 이미 진행 중입니다"],
  [/^not enough memories to review$/, () => "점검할 메모리가 2개 이상 있어야 합니다"],
  [/^proposal is already (\w+)$/, (s) => `이미 ${PROPOSAL_STATUS[s] ?? s} 제안입니다`],
  [/^the memories changed since this was proposed/, () => "제안 뒤 메모리가 바뀌었습니다. 무시하고 점검을 다시 실행하세요"],
  [/^memory #(\d+) this relies on changed since it was proposed/, (id) => `이 제안이 기대는 메모리(#${id})가 제안 뒤 바뀌었습니다. 무시하고 점검을 다시 실행하세요`],
  [/^the edited passage now occurs more than once/, () => "고칠 구절이 이제 본문에 여러 번 나옵니다. 무시하고 점검을 다시 실행하세요"],
  [/^the edited passage is no longer in the body/, () => "고칠 구절이 이제 본문에 없습니다. 무시하고 점검을 다시 실행하세요"],
  [/^the edited passages now overlap/, () => "고칠 구절들이 이제 서로 겹칩니다. 무시하고 점검을 다시 실행하세요"],
  [/^the proposed entities are no longer on the memory/, () => "제안한 엔티티가 이제 메모리에 없습니다. 무시하고 점검을 다시 실행하세요"],
  // validation
  [/^(?:content|description) looks like it contains secrets: (.*)$/, (k) => `비밀값으로 보이는 내용이 있어 저장하지 않았습니다 (${k})`],
  [/^(title|body|description|policy) is too long \(max (\d+)\)$/, (f, n) => `${FIELD[f] ?? f} 너무 깁니다 (최대 ${Number(n).toLocaleString("ko-KR")}자)`],
  [/^title is required$/, () => "제목을 입력하세요"],
  [/^(?:content|body) is required$/, () => "내용을 입력하세요"],
  [/^valid_until must be a date/, () => "유효 기한은 YYYY-MM-DD 형식의 날짜여야 합니다"],
  [/^project scope needs project_id$/, () => "프로젝트 범위에는 프로젝트를 골라야 합니다"],
  [/^standing instructions can only be \w+ by a human$/, () => "고정 지시는 사람만 쓰고 고치고 지울 수 있습니다"],
  [/^page "(.+)" already exists$/, (s) => `"${s}" 페이지가 이미 있습니다`],
  [/^page is locked$/, () => "잠긴 페이지입니다"],
  // wiki compose / graph backfill
  [/^no turns to compose$/, () => "정리할 턴이 없습니다"],
  [/^too many turns \(max (\d+)\)$/, (n) => `턴이 너무 많습니다 (최대 ${n}개)`],
  [/^some turns do not exist$/, () => "일부 턴이 없습니다"],
  [/^no memories to backfill$/, () => "그래프를 채울 메모리가 없습니다"],
  // project merge
  [/^a job is running for one of these projects/, () => "두 프로젝트 중 한쪽에서 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요"],
  [/^cannot merge a project into itself$/, () => "프로젝트를 자기 자신에 합칠 수 없습니다"],
  [/^into is required$/, () => "합칠 대상 프로젝트를 골라야 합니다"],
  [/^a and b must be different projects$/, () => "서로 다른 두 프로젝트를 골라야 합니다"],
  [/^parent_id must be a page id or null$/, () => "상위 페이지가 올바르지 않습니다"],
  [/^a page cannot be its own parent$/, () => "자기 자신을 상위 페이지로 둘 수 없습니다"],
  [/^parent page not found$/, () => "상위 페이지를 찾을 수 없습니다"],
  [/^parent must be in the same wiki$/, () => "상위 페이지는 같은 위키에 있어야 합니다"],
  [/^parent page is in the trash$/, () => "상위 페이지가 휴지통에 있습니다. 먼저 복원하세요"],
  [/^parent cannot be a page under this one$/, () => "이 페이지의 하위 페이지를 상위로 둘 수 없습니다"],
  [/^the tree would be too deep \(max (\d+) levels\)$/, (m) => `페이지 트리가 너무 깊어집니다(최대 ${m[1]}단계)`],
  [/^moves must be a non-empty list$/, () => "옮길 페이지가 없습니다"],
  [/^each move needs a page id and a parent_id$/, () => "옮길 페이지 목록의 형식이 올바르지 않습니다"],
  [/^too many moves \(max (\d+)\)$/, (m) => `한 번에 옮길 수 있는 페이지는 최대 ${m[1]}개입니다`],
  [/^parent page "(.+)" not found in this wiki$/, (m) => `상위 페이지 "${m[1]}"를 이 위키에서 찾을 수 없습니다`],
  [/^enabled must be true or false$/, () => "디버그 모드는 켜기 또는 끄기만 고를 수 있습니다"],
  [/^date must be YYYY-MM-DD$/, () => "날짜는 YYYY-MM-DD 형식이어야 합니다"],
  [/^no debug log for that day$/, () => "그날의 디버그 기록이 없습니다"],
  [/^debug mode is forced on by DEBUG_MODE$/, () => "서버 환경 변수 DEBUG_MODE로 켜져 있어 여기서 끌 수 없습니다"],
  [/^a and b must be project ids$/, () => "프로젝트 id가 올바르지 않습니다"],
  // not found
  [/^(entry|page|project|entity|revision|job|proposal|turn) not found$/, (n) => `${NOUN[n]} 찾을 수 없습니다`],
  [/^memory #(\d+) not found$/, (id) => `메모리 #${id}을(를) 찾을 수 없습니다`],
  [/^invalid (?:id|JSON body)$/, () => "잘못된 요청입니다"],
  // network (fetch rejects with TypeError)
  [/^(?:Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed)$/, () => "서버에 연결할 수 없습니다"],
];

/** Status-level fallback when no rule matches. */
function fallback(status: number | undefined): string {
  if (status === undefined) return "요청이 실패했습니다";
  if (status === 400) return "요청이 올바르지 않습니다";
  if (status === 403) return "허용되지 않는 작업입니다";
  if (status === 404) return "찾을 수 없습니다";
  if (status === 409) return "현재 상태와 맞지 않아 처리하지 못했습니다";
  if (status === 422) return "처리할 수 없는 내용입니다";
  if (status === 423) return "잠겨 있어 바꿀 수 없습니다";
  if (status >= 500) return "서버 오류가 났습니다";
  return "요청이 실패했습니다";
}

function translate(msg: string): string | null {
  for (const [re, ko] of RULES) {
    const m = re.exec(msg);
    if (m) return ko(...m.slice(1));
  }
  return null;
}

/** Korean text for an error thrown by api.ts (or anything else). Never throws. */
export function describeError(e: unknown): ErrorText {
  const raw = (e instanceof Error ? e.message : typeof e === "string" ? e : String(e ?? "")).trim();
  const status = typeof (e as { status?: unknown } | null)?.status === "number" ? (e as { status: number }).status : undefined;
  // Review apply wraps the store's error: translate the inner one when we can.
  const wrapped = /^could not apply: (.*)$/s.exec(raw);
  if (wrapped) {
    const inner = translate(wrapped[1]);
    return { text: inner ? `제안을 적용하지 못했습니다: ${inner}` : "제안을 적용하지 못했습니다", raw, known: inner !== null };
  }
  if (/^HTTP \d+$/.test(raw)) return { text: fallback(status), raw, known: false };
  const text = translate(raw);
  return text !== null ? { text, raw, known: true } : { text: fallback(status), raw, known: false };
}

/** One-line Korean text; the raw message is appended in parentheses when no rule translated it. */
export function errorText(e: unknown): string {
  const d = describeError(e);
  return d.known || !d.raw ? d.text : `${d.text} (${d.raw})`;
}

/** Why a graph revision cannot be reverted now (GraphRevision.blocked from the server). */
export interface RevertBlockLike {
  code: string;
  entry_id?: number;
  entity_id?: number;
  message: string;
}

/**
 * Korean reason for a disabled revert button. Mostly the same text the revert's error would show
 * (RULES); a block that a later action lifts says what to do instead, since the revert's own 404
 * ("both memories must exist", "entity not found") does not.
 */
export function revertBlockText(b: RevertBlockLike): string {
  if (b.code === "endpoint_trashed" && b.entry_id) return `메모리 #${b.entry_id}이(가) 휴지통에 있습니다 — 먼저 휴지통에서 되살리세요`;
  if (b.code === "entity_gone") {
    return `엔티티${b.entity_id ? ` #${b.entity_id}` : ""}이(가) 이제 없습니다(삭제되었거나 다른 엔티티에 합쳐짐) — 그 삭제나 합치기를 먼저 되돌리세요`;
  }
  return errorText(b.message);
}
