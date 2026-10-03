import "./other.css";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { api, type ActivityItem, type Entry, type Source, type TurnDetail, type TurnMessage, type TurnSummary } from "../api.ts";
import {
  ACTION_LABEL,
  CategoryBadge,
  Empty,
  ErrorBox,
  Markdown,
  SCOPE_LABEL,
  SOURCE_LABEL,
  StateBadge,
  Time,
  act,
  confirmDialog,
  go,
  isHistory,
  toast,
  useData,
  usePoll,
  useRoute,
} from "../lib.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList, SkeletonPage } from "../components/Skeleton.tsx";

/** Known server skip reasons in Korean; anything else is shown as sent. */
function turnReason(msg: string): string {
  if (/LLM is not configured/i.test(msg)) return "서버에 LLM이 설정되지 않아 정리를 건너뛰었습니다 (LLM_BASE_URL).";
  return msg;
}

// ---------------------------------------------------------------- helpers

/** Local calendar day key (YYYY-MM-DD) of an ISO time. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "오늘" / "어제" / "9월 28일" / "2025년 9월 28일". */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "오늘";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "어제";
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}년 ${md}`;
}

/** Groups items (already newest-first) by local day, keeping order. */
function groupByDay<T>(items: T[], at: (x: T) => string): { key: string; label: string; items: T[] }[] {
  const out: { key: string; label: string; items: T[] }[] = [];
  for (const x of items) {
    const k = dayKey(at(x));
    const last = out[out.length - 1];
    if (last && last.key === k) last.items.push(x);
    else out.push({ key: k, label: dayLabel(at(x)), items: [x] });
  }
  return out;
}

/** Keeps both ends of a long key: "github.com/owner…/repo". */
function middleTruncate(s: string, max = 40): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wraps every occurrence of the query's words in <mark> (case-insensitive, plain text only). */
function Highlight({ text: raw, q }: { text: string; q: string }) {
  const text = plainMd(raw);
  const terms = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!terms.length || !text) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRe).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

/** Drops markdown syntax from a one-line snippet so rows read as prose (headings, emphasis, code ticks, links, table rules). */
function plainMd(text: string): string {
  return text
    .replace(/```[a-z]*/gi, " ")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?/g, " ")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/\s+/g, " ")
    .replace(/^\s*·\s*|\s*·\s*$/g, "")
    .trim();
}

/** A ~200-char window of `text` around the first query hit, for compact rows. */
function snippetAround(text: string, q: string, size = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || flat.length <= size) return flat.slice(0, size) + (flat.length > size ? "…" : "");
  const start = Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + flat.slice(start, start + size) + (start + size < flat.length ? "…" : "");
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ kind: "ok", title: "복사됨" });
  } catch {
    toast({ kind: "error", title: "복사하지 못했습니다", description: "브라우저가 클립보드 접근을 막았습니다." });
  }
}

const OP_SIGN: Record<string, string> = { add: "+", update: "~", delete: "−", confirm: "✓" };
const OP_LABEL: Record<string, string> = { add: "추가", update: "수정", delete: "삭제", confirm: "확인", edit: "부분 수정" };
const OP_TITLE: Record<string, string> = { add: "추가한 메모리", update: "수정한 메모리", delete: "삭제한 메모리", confirm: "다시 확인한 메모리" };

const VISUALLY_HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } as const;

/** "+2 ~1 −1 ✓3" counts of what a curation changed. */
function OpCounts({ applied }: { applied: TurnSummary["applied"] }) {
  const counts = new Map<string, number>();
  for (const a of applied) counts.set(a.op, (counts.get(a.op) ?? 0) + 1);
  const order = ["add", "update", "delete", "confirm", ...[...counts.keys()].filter((k) => !(k in OP_SIGN))];
  const shown = order.filter((k) => counts.get(k));
  if (!shown.length) return null;
  return (
    <span className="op-chips">
      {shown.map((op) => (
        <span
          key={op}
          className={`op-chip op-${op}`}
          title={`${OP_TITLE[op] ?? op} ${counts.get(op)}개: ${applied
            .filter((a) => a.op === op)
            .map((a) => a.title)
            .join(", ")}`}
        >
          <b aria-hidden="true">{OP_SIGN[op] ?? op}</b>
          <span aria-hidden="true">{counts.get(op)}</span>
          <span style={VISUALLY_HIDDEN}>
            {OP_LABEL[op] ?? op} {counts.get(op)}개
          </span>
        </span>
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ home

type Attention = { n: number; label: string; href: string; icon: IconName; tone: "bad" | "warn" };

export function HomePage() {
  const stats = useData(() => api.stats(), []);
  const projects = useData(() => api.projects(), []);
  const activity = useData(() => api.activity(), []);
  const s = stats.data;
  const attention: Attention[] = s
    ? ([
        { n: s.errors, label: "정리 실패", href: "#/turns?status=error", icon: "circle-alert", tone: "bad" },
        { n: s.wikiErrors, label: "위키 정리 실패", href: "#/wiki-jobs", icon: "circle-alert", tone: "bad" },
        { n: s.reviewProposals, label: "점검 제안", href: "#/review", icon: "check-check", tone: "warn" },
        { n: s.unlinked, label: "엔티티 없는 메모리", href: "#/graph", icon: "share-2", tone: "warn" },
      ] satisfies Attention[]).filter((a) => a.n > 0)
    : [];
  const recentProjects = useMemo(() => sortProjects(projects.data ?? []).slice(0, 8), [projects.data]);
  return (
    <article className="page">
      <PageHeader title="Memory Wiki" lead="pi가 일하며 쌓은 메모리는 매 요청에 주입되고, 위키는 사람과 에이전트가 함께 쓰는 문서입니다." busy={stats.loading && Boolean(s)} />
      <ErrorBox error={stats.error} />
      {attention.length > 0 && (
        <section className="attention" aria-label="주의 필요">
          {attention.map((a) => (
            <a key={a.label} className={`card attn-card ${a.tone}`} href={a.href}>
              <Icon name={a.icon} />
              <span>
                {a.label} <b>{a.n.toLocaleString()}</b>
              </span>
              <Icon name="chevron-right" className="attn-go" />
            </a>
          ))}
        </section>
      )}
      {s ? (
        <div className="stat-grid">
          <a className="stat" href="#/w/0">
            <b>{s.pages.toLocaleString()}</b>위키 페이지
          </a>
          <a className="stat" href="#/global">
            <b>{s.entries.toLocaleString()}</b>메모리
          </a>
          <a className="stat" href="#/projects">
            <b>{s.projects.toLocaleString()}</b>프로젝트
          </a>
          <a className="stat" href="#/entities">
            <b>{s.entities.toLocaleString()}</b>엔티티
          </a>
          <a className="stat" href={s.pending ? "#/turns?status=pending" : "#/turns"}>
            <b>{s.turns.toLocaleString()}</b>턴{s.pending > 0 && <span className="stat-sub">정리 대기 {s.pending}</span>}
          </a>
        </div>
      ) : (
        stats.loading && <SkeletonList rows={1} />
      )}
      <div className="two-col home-cols">
        <section>
          <div className="section-head">
            <h2>최근 프로젝트</h2>
            {projects.data && <span className="count">{projects.data.length}</span>}
            <a className="small" href="#/projects">
              모두 보기
            </a>
          </div>
          <ErrorBox error={projects.error} />
          {projects.loading && !projects.data && <SkeletonList rows={4} />}
          {projects.data?.length === 0 && <Empty icon="folder" title="아직 프로젝트가 없습니다">pi에서 확장을 켜고 작업하면 프로젝트가 자동으로 생깁니다.</Empty>}
          {recentProjects.length > 0 && (
            <div className="list">
              {recentProjects.map((p) => (
                <a key={p.id} className="list-row" href={`#/p/${p.id}`}>
                  <span className="row-line">
                    <span className="row-title grow">{p.name}</span>
                    <span className="faint small tabular">메모리 {p.entry_count ?? 0}</span>
                  </span>
                  <span className="row-meta">
                    <span className="mono" title={p.key}>
                      {middleTruncate(p.key, 44)}
                    </span>
                    {p.last_seen_at && (
                      <>
                        · <Time iso={p.last_seen_at} />
                      </>
                    )}
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
        <section>
          <div className="section-head">
            <h2>최근 변경</h2>
            <a className="small" href="#/activity">
              전체 보기
            </a>
          </div>
          <ErrorBox error={activity.error} />
          {activity.data ? <ActivityList items={activity.data.slice(0, 12)} /> : activity.loading && <SkeletonList rows={4} />}
        </section>
      </div>
    </article>
  );
}

// -------------------------------------------------------------- projects

function sortProjects<T extends { last_seen_at: string | null; updated_at: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "") || b.updated_at.localeCompare(a.updated_at));
}

export function ProjectsPage() {
  const { data, error, loading } = useData(() => api.projects(), []);
  const sorted = useMemo(() => sortProjects(data ?? []), [data]);
  return (
    <article className="page">
      <PageHeader title="프로젝트" lead="pi 확장이 git 저장소(원격 주소 기준)로 자동 구분합니다. 최근에 쓴 순서입니다." busy={loading && Boolean(data)} />
      <ErrorBox error={error} />
      {loading && !data && <SkeletonList rows={3} />}
      {data?.length === 0 && (
        <Empty icon="folder" title="아직 프로젝트가 없습니다">
          pi에서 확장을 켜고 작업하면 프로젝트가 자동으로 생깁니다.
        </Empty>
      )}
      <div className="proj-grid">
        {sorted.map((p) => (
          <a key={p.id} className="card proj-tile" href={`#/p/${p.id}`}>
            <span className="proj-tile-name">{p.name}</span>
            <span className="proj-tile-key" title={p.key}>
              {middleTruncate(p.key, 42)}
            </span>
            <span className={`proj-tile-desc clamp-2${p.description ? "" : " none"}`}>{p.description || "설명 없음"}</span>
            <span className="proj-tile-foot">
              <span>
                메모리 <b>{p.entry_count ?? 0}</b>
              </span>
              <span>
                턴 <b>{p.turn_count ?? 0}</b>
              </span>
              {p.last_seen_at && <Time iso={p.last_seen_at} />}
            </span>
          </a>
        ))}
      </div>
    </article>
  );
}

// -------------------------------------------------------------- activity

function ActivityRow({ a }: { a: ActivityItem }) {
  return (
    <div className="list-row act-row">
      <span className={`dot src-${a.author}`} aria-hidden="true" />
      <div className="grow">
        <div>
          <strong>{SOURCE_LABEL[a.author]}</strong> {ACTION_LABEL[a.action] ?? a.action}{" "}
          <a href={`#/e/${a.entry_id}`} className={a.action === "delete" ? "strike" : undefined}>
            {a.title}
          </a>
        </div>
        <div className="row-meta">
          {a.entry_scope === "project" ? <a href={`#/p/${a.entry_project_id}`}>{a.project_name}</a> : <span>{SCOPE_LABEL[a.entry_scope]}</span>}
          <span>·</span>
          <Time iso={a.created_at} />
          {a.turn_id && (
            <>
              <span>·</span>
              <a href={`#/turns/${a.turn_id}`}>턴 #{a.turn_id}</a>
            </>
          )}
          {a.reason && (
            <>
              <span>·</span>
              <span>{a.reason}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Revisions grouped by day (오늘 / 어제 / date), each day a .list. */
export function ActivityList({ items, emptyText = "변경 기록이 없습니다" }: { items: ActivityItem[]; emptyText?: string }) {
  if (!items.length) return <Empty icon="activity" title={emptyText} />;
  return (
    <>
      {groupByDay(items, (a) => a.created_at).map((g) => (
        <section key={g.key} className="day-group" aria-label={g.label}>
          <h3 className="day-label">{g.label}</h3>
          <div className="list">
            {g.items.map((a) => (
              <ActivityRow key={a.id} a={a} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

const AUTHORS: Source[] = ["human", "llm", "agent"];

export function ActivityPage() {
  const [before, setBefore] = useState<number | undefined>();
  const [author, setAuthor] = useState<Source | "">("");
  const { data, error, loading } = useData(() => api.activity(before), [before]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of data ?? []) c[a.author] = (c[a.author] ?? 0) + 1;
    return c;
  }, [data]);
  const shown = author ? (data ?? []).filter((a) => a.author === author) : (data ?? []);
  return (
    <article className="page narrow">
      <PageHeader
        title="활동"
        lead="누가 어떤 메모리를 바꿨는지 — LLM 정리, 에이전트 도구, 사람의 편집 모두."
        busy={loading && Boolean(data)}
        toolbar={
          <div className="row" role="group" aria-label="작성자 필터">
            <button className="chip" aria-pressed={author === ""} onClick={() => setAuthor("")}>
              전체 <span className="count">{data?.length ?? 0}</span>
            </button>
            {AUTHORS.map((s) => (
              <button key={s} className="chip" aria-pressed={author === s} onClick={() => setAuthor(author === s ? "" : s)}>
                <span className={`dot src-${s}`} aria-hidden="true" />
                {SOURCE_LABEL[s]} <span className="count">{counts[s] ?? 0}</span>
              </button>
            ))}
          </div>
        }
      />
      <ErrorBox error={error} />
      {loading && !data ? <SkeletonList /> : data && <ActivityList items={shown} emptyText={author ? "이 작성자의 변경이 없습니다" : undefined} />}
      <div className="row" style={{ marginTop: "var(--space-4)" }}>
        {before && (
          <button className="btn" onClick={() => setBefore(undefined)}>
            처음으로
          </button>
        )}
        {data && data.length >= 60 && (
          <button className="btn" onClick={() => setBefore(data[data.length - 1].id)}>
            더 보기
          </button>
        )}
      </div>
    </article>
  );
}

// ----------------------------------------------------------------- turns

const STATUS_LABEL: Record<TurnSummary["status"], string> = { pending: "대기", processing: "정리 중", done: "완료", skipped: "건너뜀", error: "실패" };
const STATUS_FILTERS = ["", "pending", "done", "skipped", "error"] as const;

export function TurnsPage({ projectId, status }: { projectId?: number; status?: string }) {
  const [before, setBefore] = useState<number | undefined>();
  const { data, error, loading, reload } = useData(() => api.turns({ project_id: projectId, status, before }), [projectId, status, before]);
  const project = useData(() => (projectId ? api.project(projectId) : Promise.resolve(null)), [projectId]);
  const live = Boolean(data?.some((t) => t.status === "pending" || t.status === "processing"));
  usePoll(reload, 4000, live);
  const filterHref = (s: string) => {
    const p = new URLSearchParams();
    if (projectId) p.set("project", String(projectId));
    if (s) p.set("status", s);
    const q = p.toString();
    return `#/turns${q ? `?${q}` : ""}`;
  };
  return (
    <article className="page">
      <PageHeader
        crumbs={project.data && <a href={`#/p/${projectId}`}>{project.data.name}</a>}
        title="턴 기록"
        lead="pi가 턴을 마칠 때마다 보낸 기록과, LLM이 그걸 보고 바꾼 메모리입니다."
        busy={loading && Boolean(data)}
        toolbar={
          <>
            <div className="btn-group" role="group" aria-label="상태 필터">
              {STATUS_FILTERS.map((s) => {
                const on = (status ?? "") === s;
                return (
                  <a key={s} className={`btn small${on ? " active" : ""}`} aria-current={on ? "true" : undefined} href={filterHref(s)}>
                    {s ? STATUS_LABEL[s] : "전체"}
                  </a>
                );
              })}
            </div>
            {live && (
              <span className="faint small row" role="status">
                <span className="live-dot" aria-hidden="true" /> 정리 중인 턴이 있어 자동으로 새로 고칩니다
              </span>
            )}
          </>
        }
      />
      <ErrorBox error={error} />
      {loading && !data && <SkeletonList />}
      {data?.length === 0 && (
        <Empty icon="messages-square" title={status ? "이 상태의 기록이 없습니다" : "기록이 없습니다"}>
          {status ? undefined : "pi에서 턴을 마치면 여기에 쌓입니다."}
        </Empty>
      )}
      {data && data.length > 0 && (
        <div className="list">
          {data.map((t) => (
            <a key={t.id} className="list-row turn-row" href={`#/turns/${t.id}`}>
              <span className="row-line">
                <span className={`status st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                <span className="turn-prompt">{t.prompt || <span className="faint">(프롬프트 없음)</span>}</span>
              </span>
              <span className="row-meta">
                <span>#{t.id}</span>
                <span>·</span>
                <span>{t.project_name ?? "프로젝트 없음"}</span>
                <span>·</span>
                <Time iso={t.created_at} />
                {t.client && (
                  <>
                    <span>·</span>
                    <span>{t.client}</span>
                  </>
                )}
                {t.applied.length > 0 && <OpCounts applied={t.applied} />}
              </span>
              {t.error && <span className={`${t.status === "skipped" ? "muted" : "error-text"} small clamp-2`}>{turnReason(t.error)}</span>}
            </a>
          ))}
        </div>
      )}
      {data && data.length >= 50 && (
        <div className="row" style={{ marginTop: "var(--space-4)" }}>
          <button className="btn" onClick={() => setBefore(data[data.length - 1].id)}>
            더 보기
          </button>
        </div>
      )}
    </article>
  );
}

const SKIP_REASON: Record<string, string> = {
  duplicate: "이미 있는 메모리와 같음",
  edit_not_found: "수정할 문장을 찾지 못함",
  edit_not_unique: "수정할 문장이 여러 곳",
  edit_invalid: "수정 내용이 잘못됨",
};

function CurationSummary({ t }: { t: TurnDetail }) {
  const r = t.result;
  const skipped = r?.skipped ?? [];
  return (
    <section className="card turn-summary" aria-labelledby="turn-result-title">
      <h2 id="turn-result-title">LLM 정리 결과</h2>
      {!r ? (
        <p className="note">
          {t.status === "pending" || t.status === "processing" ? "아직 정리되지 않았습니다." : t.status === "error" ? "정리에 실패했습니다." : "정리 결과가 없습니다."}
        </p>
      ) : (
        <>
          {r.note && <p className="note">{r.note}</p>}
          {r.applied.length === 0 ? (
            <p className="note">바뀐 메모리 없음</p>
          ) : (
            <ul className="op-list">
              {r.applied.map((a, i) => (
                <li key={i}>
                  <span className={`op-chip op-${a.op}`}>
                    <b aria-hidden="true">{OP_SIGN[a.op] ?? ""}</b>
                    {OP_LABEL[a.op] ?? a.op}
                  </span>
                  <a href={`#/e/${a.entryId}`} className={a.op === "delete" ? "strike" : undefined}>
                    {a.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {skipped.length > 0 && (
            <>
              <h3>건너뜀 {skipped.length}</h3>
              <ul className="op-list">
                {skipped.map((s, i) => (
                  <li key={i}>
                    <span className="op-chip faint">{OP_LABEL[s.op] ?? s.op}</span>
                    <span className="muted">{s.title}</span>
                    <span className="reason">
                      {s.reason === "duplicate" && s.entryId ? (
                        <a href={`#/e/${s.entryId}`}>
                          {SKIP_REASON.duplicate} · #{s.entryId}
                        </a>
                      ) : (
                        (SKIP_REASON[s.reason] ?? s.reason)
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {(r.inferred?.length ?? 0) > 0 && (
            <>
              <h3>본문의 기한으로 유효 기한 설정 {r.inferred!.length}</h3>
              <ul className="op-list">
                {r.inferred!.map((x, i) => (
                  <li key={i}>
                    <span className="op-chip faint">기한</span>
                    <a href={`#/e/${x.entryId}`}>{x.title}</a>
                    <span className="reason mono">{x.valid_until}까지</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {(r.model || r.ms) && (
            <p className="row-meta" style={{ marginTop: "var(--space-3)" }}>
              {r.model && <span className="mono">{r.model}</span>}
              {r.model && r.ms ? <span>·</span> : null}
              {r.ms ? <span>{(r.ms / 1000).toFixed(1)}초</span> : null}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ChatMessage({ m }: { m: TurnMessage }) {
  if (m.role === "tool") {
    const lines = m.text ? m.text.split("\n").length : 0;
    return (
      <details className={`chat-tool${m.isError ? " chat-error" : ""}`} open={m.isError || undefined}>
        <summary>
          {m.isError ? "도구 오류" : "도구 결과"} · {m.name ?? "도구"} · {lines}줄
        </summary>
        <pre>{m.text}</pre>
      </details>
    );
  }
  if (m.role === "user") {
    return (
      <div className={`chat-user${m.isError ? " chat-error" : ""}`}>
        <div className="chat-role">사용자</div>
        {m.text && <Markdown>{m.text}</Markdown>}
      </div>
    );
  }
  return (
    <div className={`chat-assistant${m.isError ? " chat-error" : ""}`} style={m.isError ? { paddingLeft: "var(--space-3)" } : undefined}>
      <div className="chat-role">pi</div>
      {m.text && <Markdown>{m.text}</Markdown>}
      {m.toolCalls && m.toolCalls.length > 0 && (
        <div className="chat-calls">
          {m.toolCalls.map((c, j) => (
            <div key={j} className="chat-call">
              <code>{c.name}</code>
              <span className="args" title={c.args}>
                {c.args}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TurnPage({ id }: { id: number }) {
  const { data: t, error, reload } = useData(() => api.turn(id), [id]);
  usePoll(reload, 4000, t?.status === "pending" || t?.status === "processing");
  if (error && !t) return <ErrorBox error={error} />;
  if (!t) return <SkeletonPage />;
  return (
    <article className="page narrow">
      <PageHeader
        crumbs={
          <>
            <a href="#/turns">턴 기록</a>
            {t.project && (
              <>
                {" "}
                / <a href={`#/p/${t.project.id}`}>{t.project.name}</a>
              </>
            )}
          </>
        }
        title={`턴 #${t.id}`}
        actions={
          <>
            <button
              className="btn ghost danger"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: "이 턴 기록을 삭제할까요?",
                  body: <p>대화 기록이 영구 삭제됩니다. 이미 반영된 메모리는 유지됩니다.</p>,
                  confirmLabel: "기록 삭제",
                  danger: true,
                });
                if (ok && (await act(() => api.deleteTurn(t.id), { success: "턴 기록을 삭제했습니다" })) !== undefined) go("/turns");
              }}
            >
              <Icon name="trash-2" />
              기록 삭제
            </button>
            <button className="btn" disabled={t.status === "processing"} onClick={() => act(() => api.retryTurn(t.id), { success: "다시 정리하도록 요청했습니다" })}>
              <Icon name="rotate-ccw" />
              다시 정리
            </button>
          </>
        }
      >
        <div className="row-meta">
          <span className={`status st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
          <Time iso={t.created_at} />
          {t.client && (
            <>
              <span>·</span>
              <span>{t.client}</span>
            </>
          )}
          {t.cwd && (
            <>
              <span>·</span>
              <code className="mono">{t.cwd}</code>
            </>
          )}
        </div>
      </PageHeader>
      {t.error &&
        (t.status === "skipped" ? (
          <div className="callout" role="status">
            <Icon name="info" size={16} />
            <div className="callout-text">{turnReason(t.error)}</div>
          </div>
        ) : (
          <div className="error-box">{t.error}</div>
        ))}
      <CurationSummary t={t} />
      <div className="section-head">
        <h2>대화</h2>
        <span className="count">{t.payload.messages.length}개 메시지</span>
      </div>
      {t.payload.messages.length === 0 ? (
        <Empty icon="messages-square" title="대화 내용이 없습니다" />
      ) : (
        <div className="chat">
          {t.payload.messages.map((m, i) => (
            <ChatMessage key={i} m={m} />
          ))}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- search

type SearchTab = "all" | "wiki" | "memory" | "turns";
const SEARCH_TABS: { id: SearchTab; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "wiki", label: "위키" },
  { id: "memory", label: "메모리" },
  { id: "turns", label: "대화" },
];

function MemoryHit({ e, q }: { e: Entry; q: string }) {
  const history = isHistory(e);
  return (
    <a className={`list-row search-hit${history ? " is-history" : ""}`} href={`#/e/${e.id}`}>
      <span className="row-line">
        <span className="row-title grow">
          <Highlight text={e.title} q={q} />
        </span>
        <StateBadge e={e} linked={false} />
        <CategoryBadge category={e.category} />
      </span>
      {e.body && (
        <span className="snippet clamp-2">
          <Highlight text={snippetAround(e.body, q)} q={q} />
        </span>
      )}
      <span className="row-meta">
        <span>{SCOPE_LABEL[e.scope]}</span>
        <span>·</span>
        <span>#{e.id}</span>
        <span>·</span>
        <Time iso={e.updated_at} />
      </span>
    </a>
  );
}

function SearchSection({ title, count, more, children }: { title: string; count: number; more?: string; children: ReactNode }) {
  return (
    <section>
      <div className="section-head">
        <h2>{title}</h2>
        <span className="count">{count}</span>
        {more && (
          <a className="small" href={more}>
            모두 보기
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

export function SearchPage({ q }: { q: string }) {
  const route = useRoute();
  const tabParam = route.query.get("tab");
  const tab: SearchTab = tabParam === "wiki" || tabParam === "memory" || tabParam === "turns" ? tabParam : "all";
  const withHistory = route.query.get("history") === "1";
  const entries = useData(() => (q ? api.search(q, undefined, withHistory) : Promise.resolve([])), [q, withHistory]);
  const sessions = useData(() => (q ? api.sessionSearch(q) : Promise.resolve([])), [q]);
  const wiki = useData(() => (q ? api.wikiSearch(q) : Promise.resolve([])), [q]);

  const href = (t: SearchTab, h = withHistory) => {
    const p = new URLSearchParams({ q });
    if (t !== "all") p.set("tab", t);
    if (h) p.set("history", "1");
    return `#/search?${p.toString()}`;
  };
  const counts: Record<SearchTab, number> = {
    wiki: wiki.data?.length ?? 0,
    memory: entries.data?.length ?? 0,
    turns: sessions.data?.length ?? 0,
    all: (wiki.data?.length ?? 0) + (entries.data?.length ?? 0) + (sessions.data?.length ?? 0),
  };
  const ready = Boolean(entries.data && wiki.data && sessions.data);
  const loaded: Record<SearchTab, boolean> = { all: ready, wiki: Boolean(wiki.data), memory: Boolean(entries.data), turns: Boolean(sessions.data) };
  const busy = entries.loading || wiki.loading || sessions.loading;
  const limit = tab === "all" ? 5 : Infinity;

  const wikiList = wiki.data && wiki.data.length > 0 && (
    <div className="list">
      {wiki.data.slice(0, limit).map((h) => (
        <a key={h.id} className="list-row search-hit" href={`#/w/${h.project_id ?? 0}/${encodeURIComponent(h.slug)}`}>
          <span className="row-line">
            <span className="row-title grow">
              <Highlight text={h.title} q={q} />
            </span>
            <span className="mono faint small">{h.slug}</span>
          </span>
          {h.snippet && (
            <span className="snippet clamp-2">
              <Highlight text={h.snippet} q={q} />
            </span>
          )}
        </a>
      ))}
    </div>
  );
  const memoryList = entries.data && entries.data.length > 0 && (
    <div className="list">
      {entries.data.slice(0, limit).map((e) => (
        <MemoryHit key={e.id} e={e} q={q} />
      ))}
    </div>
  );
  const turnList = sessions.data && sessions.data.length > 0 && (
    <div className="list">
      {sessions.data.slice(0, limit).map((h) => (
        <a key={h.id} className="list-row search-hit" href={`#/turns/${h.id}`}>
          <span className="row-meta">
            <span>턴 #{h.id}</span>
            <span>·</span>
            <span>{h.project_name ?? "프로젝트 없음"}</span>
            <span>·</span>
            <Time iso={h.created_at} />
          </span>
          <span className="snippet clamp-2">
            <Highlight text={h.snippet} q={q} />
          </span>
        </a>
      ))}
    </div>
  );

  return (
    <article className="page">
      <PageHeader
        title={q ? `“${q}” 검색` : "검색"}
        busy={busy && ready}
        tabs={
          q ? (
            <nav className="tabs" aria-label="검색 결과 종류">
              {SEARCH_TABS.map((t) => (
                <a key={t.id} href={href(t.id)} className={tab === t.id ? "active" : undefined} aria-current={tab === t.id ? "page" : undefined}>
                  {t.label}
                  <span className="count">{loaded[t.id] ? counts[t.id] : "…"}</span>
                </a>
              ))}
            </nav>
          ) : undefined
        }
        toolbar={
          q && (tab === "all" || tab === "memory") ? (
            <label className="check small search-opts">
              <input type="checkbox" checked={withHistory} onChange={(e) => go(href(tab, e.target.checked).slice(1))} />
              지난 사실 포함
              <span className="faint"> (대체되거나 만료된 메모리)</span>
            </label>
          ) : undefined
        }
      />
      {!q ? (
        <Empty icon="search" title="검색어를 입력하세요">
          ⌘K 또는 / 로 검색창을 열 수 있습니다.
        </Empty>
      ) : (
        <>
          <ErrorBox error={entries.error ?? sessions.error ?? wiki.error} />
          {busy && !ready && <SkeletonList rows={4} />}
          {ready && counts.all === 0 && (
            <Empty icon="search" title="일치하는 결과가 없습니다">
              {withHistory ? "다른 검색어를 시도해 보세요." : "다른 검색어를 쓰거나 '지난 사실 포함'을 켜 보세요."}
            </Empty>
          )}
          {ready && tab === "all" && counts.all > 0 && (
            <>
              {counts.wiki > 0 && (
                <SearchSection title="위키" count={counts.wiki} more={counts.wiki > limit ? href("wiki") : undefined}>
                  {wikiList}
                </SearchSection>
              )}
              {counts.memory > 0 && (
                <SearchSection title="메모리" count={counts.memory} more={counts.memory > limit ? href("memory") : undefined}>
                  {memoryList}
                </SearchSection>
              )}
              {counts.turns > 0 && (
                <SearchSection title="대화" count={counts.turns} more={counts.turns > limit ? href("turns") : undefined}>
                  {turnList}
                </SearchSection>
              )}
            </>
          )}
          {ready && tab !== "all" && counts.all > 0 && (
            <div style={{ marginTop: "var(--space-4)" }}>
              {tab === "wiki" && (wikiList || <Empty icon="book-open" title="일치하는 위키 페이지가 없습니다" />)}
              {tab === "memory" && (memoryList || <Empty icon="sticky-note" title="일치하는 메모리가 없습니다" />)}
              {tab === "turns" && (turnList || <Empty icon="messages-square" title="일치하는 대화가 없습니다" />)}
            </div>
          )}
        </>
      )}
    </article>
  );
}

// ----------------------------------------------------------------- trash

export function TrashPage() {
  const { data, error, loading } = useData(() => api.entries({ deleted: true }), []);
  return (
    <article className="page narrow">
      <PageHeader title="휴지통" lead="삭제된 메모리입니다. 복원하거나 영구 삭제할 수 있습니다." busy={loading && Boolean(data)} />
      <ErrorBox error={error} />
      {loading && !data && <SkeletonList />}
      {data?.length === 0 && <Empty icon="trash-2" title="휴지통이 비어 있습니다" />}
      {data && data.length > 0 && (
        <div className="list">
          {data.map((e) => (
            <div key={e.id} className="list-row trash-row">
              <div className="grow">
                <span className="row-line">
                  <a className="row-title" href={`#/e/${e.id}`}>
                    {e.title}
                  </a>
                  <CategoryBadge category={e.category} />
                </span>
                <span className="row-meta">
                  <span>{SCOPE_LABEL[e.scope]}</span>
                  <span>·</span>
                  <span>
                    삭제 <Time iso={e.deleted_at ?? e.updated_at} />
                  </span>
                </span>
              </div>
              <div className="actions">
                <button className="btn small ghost" onClick={() => act(() => api.restoreEntry(e.id), { success: `'${e.title}' 복원했습니다` })}>
                  <Icon name="rotate-ccw" size={14} />
                  복원
                </button>
                <button
                  className="btn small ghost danger"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: "영구 삭제할까요?",
                      body: <p>'{e.title}'을(를) 영구 삭제합니다. 이력까지 지워지며 되돌릴 수 없습니다.</p>,
                      confirmLabel: "영구 삭제",
                      danger: true,
                    });
                    if (ok) act(() => api.purgeEntry(e.id), { success: "영구 삭제했습니다" });
                  }}
                >
                  <Icon name="trash-2" size={14} />
                  영구 삭제
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

// --------------------------------------------------------------- preview

const SECTION_META: Record<string, { label: string; color: string }> = {
  "memory-policy": { label: "메모리 정책", color: "var(--color-text-3)" },
  memory: { label: "메모리", color: "var(--color-text-3)" },
  "standing-instructions": { label: "고정 지시", color: "var(--c-standing)" },
  "user-profile": { label: "사용자 프로필", color: "var(--c-preference)" },
  "project-memory": { label: "프로젝트 메모리", color: "var(--c-fact)" },
  "global-memory": { label: "전역 메모리", color: "var(--c-convention)" },
  "wiki-pages": { label: "위키 목록", color: "var(--c-decision)" },
};
const FALLBACK_COLORS = ["var(--c-insight)", "var(--c-tool-quirk)", "var(--c-correction)", "var(--c-failure)"];

interface BlockSection {
  key: string;
  label: string;
  chars: number;
  color: string;
}

/**
 * Splits the injected system block into leaf sections: `<tag …>…</tag>` blocks (a block whose body
 * holds further blocks is split into those), or `## ` headings when there are no tags. Leftover
 * characters (wrappers, newlines) go to "기타" so the parts always add up to the whole.
 */
function splitSections(text: string): BlockSection[] {
  const out: { key: string; label: string; chars: number }[] = [];
  const tagRe = /^<([a-z][\w-]*)(?:\s[^>]*)?>\n([\s\S]*?)\n<\/\1>$/gm;
  const walk = (s: string): boolean => {
    let found = false;
    for (const m of s.matchAll(tagRe)) {
      found = true;
      const [whole, tag, body] = m;
      if (!walk(body)) {
        const title = /title="([^"]*)"/.exec(whole.slice(0, whole.indexOf(">")))?.[1];
        out.push({ key: tag, label: SECTION_META[tag]?.label ?? (title ? `${tag} · ${title}` : tag), chars: whole.length });
      }
    }
    return found;
  };
  if (!walk(text)) {
    const parts = text.split(/^(?=## )/m);
    for (const p of parts) {
      if (!p.trim()) continue;
      const head = /^## (.*)$/m.exec(p)?.[1];
      out.push({ key: head ?? "intro", label: head ?? "머리말", chars: p.length });
    }
  }
  const used = out.reduce((n, s) => n + s.chars, 0);
  if (text.length - used > 0 && out.length) out.push({ key: "rest", label: "기타", chars: text.length - used });
  let fb = 0;
  return out.map((s) => ({ ...s, color: SECTION_META[s.key]?.color ?? (s.key === "rest" ? "var(--color-border-strong)" : FALLBACK_COLORS[fb++ % FALLBACK_COLORS.length]) }));
}

function BudgetBar({ text }: { text: string }) {
  const sections = useMemo(() => splitSections(text), [text]);
  if (sections.length < 2) return null;
  const total = text.length || 1;
  return (
    <div className="budget">
      <div className="budget-bar" role="img" aria-label={`구성: ${sections.map((s) => `${s.label} ${s.chars.toLocaleString()}자`).join(", ")}`}>
        {sections.map((s, i) => (
          <span key={i} style={{ flexGrow: s.chars, flexBasis: 0, background: s.color }} title={`${s.label} · ${s.chars.toLocaleString()}자`} />
        ))}
      </div>
      <ul className="budget-legend">
        {sections.map((s, i) => (
          <li key={i}>
            <span className="swatch-dot" style={{ background: s.color }} aria-hidden="true" />
            <span className="nowrap" style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={s.label}>
              {s.label}
            </span>
            <span className="n">
              {s.chars.toLocaleString()}자 · {Math.round((s.chars / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CopyPre({ text, label }: { text: string; label: string }) {
  return (
    <div className="copy-wrap">
      <button className="icon-btn" aria-label={`${label} 복사`} title="복사" onClick={() => copyText(text)}>
        <Icon name="copy" />
      </button>
      <pre className="inject">{text}</pre>
    </div>
  );
}

export function PreviewPage({ projectId }: { projectId?: number }) {
  const [prompt, setPrompt] = useState("");
  const [q, setQ] = useState("");
  const projects = useData(() => api.projects(), []);
  const { data, error, loading } = useData(() => api.preview(projectId, q), [projectId, q]);
  return (
    <article className="page">
      <PageHeader
        title="주입 미리보기"
        lead="pi가 매 요청마다 시스템 프롬프트와 숨은 메시지로 받는 내용입니다."
        busy={loading && Boolean(data)}
        toolbar={
          <>
            <select aria-label="프로젝트" value={projectId ?? ""} onChange={(e) => go(`/preview${e.target.value ? `?project=${e.target.value}` : ""}`)}>
              <option value="">프로젝트 없음</option>
              {sortProjects(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              className="filter wide"
              aria-label="예시 프롬프트"
              placeholder="예시 프롬프트 (관련 기억 회상 확인)"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setQ(prompt)}
            />
            <button className="btn" onClick={() => setQ(prompt)}>
              확인
            </button>
          </>
        }
      />
      <ErrorBox error={error} />
      {loading && !data && <SkeletonList rows={3} />}
      {data && (
        <>
          <div className="section-head">
            <h2>시스템 프롬프트 블록</h2>
            <span className="count">{data.system.length.toLocaleString()}자</span>
            <span className="faint small">메모리 {data.included.length}개</span>
          </div>
          <BudgetBar text={data.system} />
          <CopyPre text={data.system} label="시스템 프롬프트 블록" />
          <div className="section-head">
            <h2>이번 요청 회상</h2>
            <span className="count">{data.recall.length.toLocaleString()}자</span>
            {data.recall && <span className="faint small">메모리 {data.recalled.length}개</span>}
          </div>
          {data.recall ? (
            <CopyPre text={data.recall} label="회상 블록" />
          ) : (
            <Empty icon="eye" title={q ? "추가로 회상된 기억이 없습니다" : "예시 프롬프트를 입력해 보세요"}>
              {q ? undefined : "입력한 프롬프트에 맞춰 회상되는 메모리가 여기에 표시됩니다."}
            </Empty>
          )}
        </>
      )}
    </article>
  );
}
