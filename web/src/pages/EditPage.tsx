import "./scope.css";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type Entry, type Scope } from "../api.ts";
import { CATEGORY_LABEL, CATEGORY_ORDER, ErrorBox, MOD_LABEL, Markdown, go, leaveTo as leave, toast, useData, changed, useLeaveGuard } from "../lib.tsx";
import { Icon } from "../components/Icon.tsx";
import { SkeletonPage } from "../components/Skeleton.tsx";

interface Props {
  id?: number;
  defaults?: { scope?: Scope; project?: number; category?: string };
}

// ------------------------------------------------------------------------ helpers

const splitList = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);
const uniq = (xs: string[]) => [...new Set(xs)];

interface FormState {
  scope: Scope;
  project_id: number | null;
  category: string;
  title: string;
  body: string;
  pinned: boolean;
  tagText: string;
  entityText: string;
  keywords: string[];
  valid_until: string;
}

const snapshot = (f: FormState) => JSON.stringify(f);

// --------------------------------------------------------------------------- page

export function EditPage({ id, defaults }: Props) {
  const existing = useData(() => (id ? api.entry(id) : Promise.resolve(null)), [id]);
  const projects = useData(() => api.projects(), []);
  const initial: FormState = {
    scope: defaults?.scope ?? "global",
    project_id: defaults?.project ?? null,
    category: defaults?.category ?? "fact",
    title: "",
    body: "",
    pinned: false,
    tagText: "",
    entityText: "",
    keywords: [],
    valid_until: "",
  };
  const [form, setForm] = useState<FormState>(initial);
  const [base, setBase] = useState(() => snapshot(initial));
  const [loadedEntities, setLoadedEntities] = useState("");
  const [kwDraft, setKwDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const e = existing.data?.entry;
    if (!e || loaded.current) return;
    loaded.current = true;
    const names = (existing.data?.entities ?? []).map((n) => n.name).join(", ");
    const next: FormState = {
      scope: e.scope,
      project_id: e.project_id,
      category: e.category,
      title: e.title,
      body: e.body,
      pinned: e.pinned,
      tagText: e.tags.join(", "),
      entityText: names,
      keywords: e.keywords ?? [],
      valid_until: e.valid_until ?? "",
    };
    setForm(next);
    setBase(snapshot(next));
    setLoadedEntities(names);
  }, [existing.data]);

  const dirty = snapshot(form) !== base || kwDraft.trim() !== "";
  const route = id ? `/e/${id}/edit` : window.location.hash.replace(/^#/, "");

  // Leave guards: hashchange (module listener in lib.tsx) and tab close / reload.
  useLeaveGuard(route, dirty);

  // Auto-grow the body textarea (fallback for browsers without field-sizing).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(420, el.scrollHeight + 2)}px`;
  }, [form.body, mode]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const addKeywords = (raw: string) => {
    const words = splitList(raw);
    if (words.length) setForm((f) => ({ ...f, keywords: uniq([...f.keywords, ...words]) }));
  };

  const save = async (andLeave: boolean) => {
    if (saving) return;
    if (!form.title.trim()) {
      setError("제목을 입력하세요.");
      return;
    }
    if (form.scope === "project" && !form.project_id) {
      setError("프로젝트를 선택하세요.");
      return;
    }
    setSaving(true);
    setError(null);
    const keywords = uniq([...form.keywords, ...splitList(kwDraft)]);
    const payload: Partial<Entry> & { entities?: string[] } = {
      scope: form.scope,
      project_id: form.scope === "project" ? form.project_id : null,
      category: form.category,
      title: form.title,
      body: form.body,
      pinned: form.pinned,
      tags: splitList(form.tagText),
      keywords,
      valid_until: form.valid_until || null,
      // Only send entities when edited, so ones the curator added meanwhile are not dropped.
      ...(!id || form.entityText !== loadedEntities ? { entities: splitList(form.entityText) } : {}),
    };
    try {
      const saved = id ? await api.updateEntry(id, payload) : await api.createEntry(payload);
      changed();
      if (andLeave) {
        leave(`/e/${saved.id}`);
        toast({ kind: "ok", title: "저장했습니다" });
      } else if (!id) {
        toast({ kind: "ok", title: "메모리를 만들었습니다" });
        leave(`/e/${saved.id}/edit`, true);
      } else {
        const next = { ...form, keywords };
        setForm(next);
        setKwDraft("");
        setBase(snapshot(next));
        setLoadedEntities(form.entityText);
        toast({ kind: "ok", title: "저장했습니다" });
      }
    } catch (e) {
      setError((e as Error).message);
      toast({ kind: "error", title: "저장하지 못했습니다", description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    // The guard asks before discarding when dirty.
    if (id) go(`/e/${id}`);
    else history.back();
  };

  // ⌘/Ctrl+S save, ⌘/Ctrl+Enter save and leave — work from any field.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        saveRef.current(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        saveRef.current(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  if (id && !existing.data && !existing.error) return <SkeletonPage />;

  const onKwKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" && !(e.metaKey || e.ctrlKey)) || e.key === ",") {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      addKeywords(kwDraft);
      setKwDraft("");
    } else if (e.key === "Backspace" && !kwDraft && form.keywords.length) {
      e.preventDefault();
      set("keywords", form.keywords.slice(0, -1));
    }
  };

  const categories = CATEGORY_ORDER.includes(form.category) ? CATEGORY_ORDER : [...CATEGORY_ORDER, form.category];

  return (
    <article className="page wide edit-page">
      <header className="page-head">
        <div className="crumbs">
          {id ? (
            <a href={`#/e/${id}`}>← 메모리로 돌아가기</a>
          ) : (
            <a href="#/" onClick={(ev) => (ev.preventDefault(), history.back())}>
              ← 뒤로
            </a>
          )}
          <span className="faint">·</span>
          <span className="faint">{id ? `메모리 #${id} 편집` : "새 메모리"}</span>
        </div>
      </header>
      <ErrorBox error={error ?? existing.error} />

      <div className="form">
        <input
          className="edit-title"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="제목 — 짧고 구체적으로"
          aria-label="제목"
          autoFocus={!id}
        />

        <div className="edit-meta">
          <div className="field">
            <span className="field-label" id="f-scope">
              범위
            </span>
            <select aria-labelledby="f-scope" value={form.scope} onChange={(e) => set("scope", e.target.value as Scope)}>
              <option value="global">전역</option>
              <option value="user">사용자</option>
              <option value="project">프로젝트</option>
            </select>
          </div>
          {form.scope === "project" && (
            <div className="field">
              <span className="field-label" id="f-project">
                프로젝트
              </span>
              <select aria-labelledby="f-project" value={form.project_id ?? ""} onChange={(e) => set("project_id", Number(e.target.value) || null)}>
                <option value="">선택…</option>
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="check-inline">
            <input type="checkbox" checked={form.pinned} onChange={(e) => set("pinned", e.target.checked)} />
            <Icon name="pin" size={14} />
            고정 (주입 시 우선)
          </label>
        </div>

        <div className="field">
          <span className="field-label" id="f-cat">
            분류
          </span>
          <div className="cat-chips" role="radiogroup" aria-labelledby="f-cat">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className="chip"
                role="radio"
                aria-checked={form.category === c}
                aria-pressed={form.category === c}
                onClick={() => set("category", c)}
              >
                <span className={`cat-dot cat-${c}`} aria-hidden />
                {CATEGORY_LABEL[c] ?? c}
              </button>
            ))}
          </div>
        </div>

        {form.category === "standing" && (
          <div className="callout warn" role="note">
            <Icon name="alert-triangle" size={15} />
            <span className="callout-text">고정 지시는 모든 세션의 프롬프트에 항상 들어가며 LLM·에이전트는 수정할 수 없습니다. 꼭 필요한 규칙만 짧게 적으세요.</span>
          </div>
        )}

        <div className="edit-split" data-mode={mode}>
          <div className="edit-source-pane">
            <div className="edit-pane-head">
              <span className="field-label pane-label" id="f-body">
                본문 (Markdown)
              </span>
              <div className="btn-group edit-mode-toggle" role="group" aria-label="보기 전환">
                <button type="button" className={`btn small${mode === "edit" ? " active" : ""}`} aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
                  편집
                </button>
                <button type="button" className={`btn small${mode === "preview" ? " active" : ""}`} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
                  미리보기
                </button>
              </div>
            </div>
            <textarea
              ref={bodyRef}
              className="edit-body"
              aria-labelledby="f-body"
              value={form.body}
              onChange={(e) => set("body", e.target.value)}
              placeholder="왜 그런지까지 적어두면 좋습니다."
              autoFocus={Boolean(id)}
            />
          </div>
          <div className="edit-preview-pane">
            <div className="edit-pane-head">
              <span className="field-label pane-label">미리보기</span>
              {mode === "preview" && (
                <div className="btn-group edit-mode-toggle" role="group" aria-label="보기 전환">
                  <button type="button" className="btn small" aria-pressed={false} onClick={() => setMode("edit")}>
                    편집
                  </button>
                  <button type="button" className="btn small active" aria-pressed>
                    미리보기
                  </button>
                </div>
              )}
            </div>
            <div className="edit-preview" aria-live="off">
              {form.body ? <Markdown>{form.body}</Markdown> : <p className="hint">본문을 입력하면 여기에 표시됩니다.</p>}
            </div>
          </div>
        </div>

        <div className="edit-fields">
          <label className="field">
            <span className="field-label">태그 (쉼표로 구분)</span>
            <input value={form.tagText} onChange={(e) => set("tagText", e.target.value)} placeholder="docker, deploy" />
          </label>
          <label className="field">
            <span className="field-label">엔티티 (쉼표로 구분 · 그래프 노드)</span>
            <input value={form.entityText} onChange={(e) => set("entityText", e.target.value)} placeholder="PostgreSQL, docker compose, Tailscale" />
          </label>
          <div className="field">
            <span className="field-label" id="f-kw">
              검색 키워드
            </span>
            <div className="chips-input" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
              {form.keywords.map((k) => (
                <span key={k} className="kw-chip">
                  {k}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`키워드 '${k}' 삭제`}
                    title="삭제"
                    onClick={(e) => {
                      e.stopPropagation();
                      set(
                        "keywords",
                        form.keywords.filter((x) => x !== k),
                      );
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              <input
                aria-labelledby="f-kw"
                aria-describedby="f-kw-hint"
                value={kwDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v.includes(",")) {
                    const parts = v.split(",");
                    addKeywords(parts.slice(0, -1).join(","));
                    setKwDraft(parts[parts.length - 1]);
                  } else setKwDraft(v);
                }}
                onKeyDown={onKwKey}
                onBlur={() => {
                  if (kwDraft.trim()) {
                    addKeywords(kwDraft);
                    setKwDraft("");
                  }
                }}
                placeholder={form.keywords.length ? "" : "예: 배포, deploy, 디플로이"}
              />
            </div>
            <p className="hint" id="f-kw-hint">
              동의어·번역·다른 표기. 검색에만 쓰이고 프롬프트에는 들어가지 않습니다.
            </p>
          </div>
          <div className="field">
            <span className="field-label" id="f-valid">
              유효 기한
            </span>
            <div className="date-row">
              <input type="date" aria-labelledby="f-valid" aria-describedby="f-valid-hint" value={form.valid_until} onChange={(e) => set("valid_until", e.target.value)} />
              {form.valid_until && (
                <button type="button" className="icon-btn" aria-label="유효 기한 지우기" title="기한 지우기" onClick={() => set("valid_until", "")}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
            <p className="hint" id="f-valid-hint">
              이 날짜가 지나면 프롬프트에 넣지 않습니다(이력으로 남음).
            </p>
          </div>
        </div>
      </div>

      <div className="edit-footer">
        <button className="btn primary" disabled={saving || !form.title.trim()} aria-busy={saving} onClick={() => save(false)} title={`저장 (${MOD_LABEL}+S)`}>
          {saving ? "저장 중…" : "저장"} <kbd>{MOD_LABEL === "⌘" ? "⌘S" : "Ctrl+S"}</kbd>
        </button>
        <button className="btn" disabled={saving || !form.title.trim()} onClick={() => save(true)} title={`저장 후 닫기 (${MOD_LABEL}+Enter)`}>
          저장 후 닫기 <kbd>{MOD_LABEL === "⌘" ? "⌘↵" : "Ctrl+↵"}</kbd>
        </button>
        <button className="btn ghost" onClick={cancel}>
          취소
        </button>
        <span className="spacer" />
        {dirty && <span className="dirty-note">저장 안 된 변경</span>}
      </div>
    </article>
  );
}
