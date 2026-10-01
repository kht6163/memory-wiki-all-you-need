import { useEffect, useState } from "react";
import { api, type Entry, type Scope } from "../api.ts";
import { CATEGORY_LABEL, CATEGORY_ORDER, ErrorBox, Markdown, act, go, useData } from "../lib.tsx";

interface Props {
  id?: number;
  defaults?: { scope?: Scope; project?: number; category?: string };
}

export function EditPage({ id, defaults }: Props) {
  const existing = useData(() => (id ? api.entry(id) : Promise.resolve(null)), [id]);
  const projects = useData(() => api.projects(), []);
  const [form, setForm] = useState<Partial<Entry>>({
    scope: defaults?.scope ?? "global",
    project_id: defaults?.project ?? null,
    category: defaults?.category ?? "fact",
    title: "",
    body: "",
    tags: [],
    pinned: false,
  });
  const [tagText, setTagText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const e = existing.data?.entry;
    if (e) {
      setForm(e);
      setTagText(e.tags.join(", "));
    }
  }, [existing.data]);

  const set = <K extends keyof Entry>(k: K, v: Entry[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      scope: form.scope,
      project_id: form.scope === "project" ? form.project_id : null,
      category: form.category,
      title: form.title,
      body: form.body,
      pinned: form.pinned,
      tags: tagText.split(",").map((t) => t.trim()).filter(Boolean),
    };
    try {
      const saved = id ? await api.updateEntry(id, payload) : await api.createEntry(payload);
      await act(async () => saved);
      go(`/e/${saved.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="page">
      <header className="page-head">
        <div className="crumbs">{id ? <a href={`#/e/${id}`}>← 메모리로 돌아가기</a> : <a href="#/" onClick={(ev) => (ev.preventDefault(), history.back())}>← 뒤로</a>}</div>
        <h1>{id ? "메모리 편집" : "새 메모리"}</h1>
      </header>
      <ErrorBox error={error ?? existing.error} />
      <div className="form">
        <div className="form-row">
          <label>
            범위
            <select value={form.scope} onChange={(e) => set("scope", e.target.value as Scope)}>
              <option value="global">전역</option>
              <option value="user">사용자</option>
              <option value="project">프로젝트</option>
            </select>
          </label>
          {form.scope === "project" && (
            <label>
              프로젝트
              <select value={form.project_id ?? ""} onChange={(e) => set("project_id", Number(e.target.value) || null)}>
                <option value="">선택…</option>
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            분류
            <select value={form.category} onChange={(e) => set("category", e.target.value)}>
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={Boolean(form.pinned)} onChange={(e) => set("pinned", e.target.checked)} />
            고정 (주입 시 우선)
          </label>
        </div>
        <label>
          제목
          <input className="title-input" value={form.title ?? ""} onChange={(e) => set("title", e.target.value)} placeholder="짧고 구체적으로" autoFocus />
        </label>
        <div className="editor">
          <label>
            본문 (Markdown)
            <textarea value={form.body ?? ""} onChange={(e) => set("body", e.target.value)} rows={16} placeholder="왜 그런지까지 적어두면 좋습니다." />
          </label>
          <div className="preview">
            <div className="preview-label">미리보기</div>
            {form.body ? <Markdown>{form.body}</Markdown> : <p className="muted">본문을 입력하면 여기에 표시됩니다.</p>}
          </div>
        </div>
        <label>
          태그 (쉼표로 구분)
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="docker, deploy" />
        </label>
        {form.category === "standing" && <p className="hint">고정 지시는 모든 세션의 프롬프트에 항상 들어가며 LLM·에이전트는 수정할 수 없습니다.</p>}
        <div className="row">
          <button className="btn primary" disabled={saving || !form.title?.trim()} onClick={save}>
            {saving ? "저장 중…" : "저장"}
          </button>
          <button className="btn" onClick={() => history.back()}>
            취소
          </button>
        </div>
      </div>
    </article>
  );
}
