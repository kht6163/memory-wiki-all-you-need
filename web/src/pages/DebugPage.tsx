import "./debug.css";
import { useState } from "react";
import { api, type DebugInfo, type RecallReport } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList } from "../components/Skeleton.tsx";
import { Empty, ErrorBox, act, useData } from "../lib.tsx";

// Debug mode (ADR-0035): the server keeps one JSON-lines file per day with
// requests, recall reasons, searches, LLM prompts and replies, curation results
// and embedding calls. This page turns it on and off and lists the day files.

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const SOURCE: Record<DebugInfo["source"], string> = { env: "환경 변수 DEBUG_MODE", file: "웹에서 설정", default: "기본값" };

export function DebugPage() {
  const { data, error, loading, reload } = useData(() => api.debug(), []);
  const toggle = (enabled: boolean) => act(() => api.setDebug(enabled), { success: enabled ? "디버그 모드를 켰습니다" : "디버그 모드를 껐습니다" }).then(() => reload());
  return (
    <article className="page">
      <PageHeader title="디버그 모드" lead="켜 두면 서버가 요청, 회상 근거, 검색 결과, LLM 프롬프트와 응답, 턴 정리 결과, 임베딩 호출을 날짜별 파일로 모읍니다. 기능을 조정할 때 씁니다." busy={loading && Boolean(data)} />
      <ErrorBox error={error} />
      {loading && !data && <SkeletonList rows={2} />}
      {data && (
        <>
          <dl className="card debug-state">
            <dt id="debug-switch-label">디버그 모드</dt>
            <dd>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={data.enabled}
                aria-labelledby="debug-switch-label"
                disabled={data.source === "env"}
                title={data.source === "env" ? "DEBUG_MODE 환경 변수로 켜져 있습니다" : data.enabled ? "끄기" : "켜기"}
                onClick={() => toggle(!data.enabled)}
              />
              <span className="muted small"> {SOURCE[data.source]}</span>
            </dd>
            <dt>저장 위치</dt>
            <dd>
              <code>{data.dir}</code>
            </dd>
            <dt>보관</dt>
            <dd>
              최근 {data.keepDays}일, 하루 최대 {data.maxMbPerDay} MB
            </dd>
          </dl>
          {data.enabled && (
            <div className="callout warn" role="note">
              <Icon name="alert-triangle" size={16} />
              <span className="callout-text">프롬프트와 대화 내용이 그대로 기록됩니다(알려진 비밀값 형태는 가림). 필요한 동안만 켜 두세요.</span>
            </div>
          )}
          <RecallMeasure />
          <div className="section-head">
            <h2>날짜별 기록</h2>
            <span className="count">{data.files.length}</span>
          </div>
          {data.files.length === 0 ? (
            <Empty icon="file-text" title="기록이 없습니다">
              디버그 모드를 켜면 오늘 날짜 파일부터 쌓입니다.
            </Empty>
          ) : (
            <div className="list">
              {data.files.map((f) => (
                <div key={f.date} className="list-row debug-file">
                  <Icon name="file-text" size={16} />
                  <span className="tabular">{f.date}</span>
                  <span className="muted small tabular">{kb(f.bytes)}</span>
                  <a className="btn small" href={`/api/debug/logs/${f.date}`} target="_blank" rel="noreferrer">
                    열기
                  </a>
                  <a className="btn small" href={`/api/debug/logs/${f.date}?download=1`}>
                    받기
                  </a>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}

const AGENT: Record<string, string> = { pi: "pi", "claude-code": "Claude Code", "?": "알 수 없음(옛 확장)" };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * Recall measurement (ADR-0050): what recall injected over a period and whether the agent used
 * it, summed from the debug log. Numbers only cover days with debug mode on.
 */
function RecallMeasure() {
  const [days, setDays] = useState(14);
  const { data: r, error, loading } = useData(() => api.recallReport(days), [days]);
  const prompts = r ? sum(r.prompts) : 0;
  const hits = r ? r.hits.keywordOnly + r.hits.vectorOnly + r.hits.both : 0;
  return (
    <>
      <div className="section-head">
        <h2>회상 측정</h2>
        <select aria-label="측정 기간" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 14, 30].map((d) => (
            <option key={d} value={d}>
              최근 {d}일
            </option>
          ))}
        </select>
      </div>
      <p className="section-desc">
        디버그 기록에서 모은 회상 통계입니다. "쓰임"은 에이전트의 답이나 도구 호출에 그 메모리의 <code>#id</code>가 나오거나, 질문에 없던 그 메모리의 드문 단어가 2개 이상 나온 경우입니다(추정치). 디버그 모드가 꺼져 있던 날은 빠집니다.
      </p>
      <ErrorBox error={error} />
      {loading && !r && <SkeletonList rows={2} />}
      {r && (
        <dl className="card debug-state recall-measure">
          <dt>기간</dt>
          <dd className="tabular">
            {r.from} ~ {r.to}
          </dd>
          <dt>프롬프트</dt>
          <dd className="tabular">
            {prompts}개
            {Object.entries(r.prompts).map(([k, n]) => (
              <span key={k} className="muted small">
                {AGENT[k] ?? k} {n}
              </span>
            ))}
          </dd>
          <dt>회상</dt>
          <dd className="tabular">
            평균 {prompts ? (r.recalled / prompts).toFixed(1) : "–"}개 · 빈 회상 {r.emptyRecall}번({pct(r.emptyRecall, prompts)})
          </dd>
          <dt>찾은 경로</dt>
          <dd className="tabular">
            단어만 {r.hits.keywordOnly} · 뜻만 {r.hits.vectorOnly} · 둘 다 {r.hits.both}
            <span className="muted small">뜻만 {pct(r.hits.vectorOnly, hits)}</span>
          </dd>
          <dt>관문이 거름</dt>
          <dd className="tabular">
            {r.gatedPrompts ? (
              <>
                흔한 단어 {r.gated.common} · 뜻 z {r.gated.minZ} · 단어 적중의 뜻 z {r.gated.keywordMinZ} · 그래프 연결의 뜻 z {r.gated.graphMinZ ?? 0}
                <span className="muted small">프롬프트 {r.gatedPrompts}개 기준</span>
              </>
            ) : (
              "기록 없음 — 서버 0.24.0부터 셉니다"
            )}
          </dd>
          <dt>그래프 덧붙임</dt>
          <dd className="tabular">
            {Object.keys(r.extras).length
              ? Object.entries(r.extras)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => `${k} ${n}`)
                  .join(" · ")
              : "없음"}
          </dd>
          <dt>쓰임</dt>
          <dd className="tabular">
            {Object.keys(r.use).length
              ? Object.entries(r.use).map(([k, u]) => (
                  <span key={k}>
                    {AGENT[k] ?? k}: 메모리 {u.memories}개 중 {u.used}개({pct(u.used, u.memories)}), #id 인용 {u.cited} · 프롬프트 {u.prompts}
                  </span>
                ))
              : "아직 없음 — 새 확장(0.24.0 이상)이 보낸 턴부터 셉니다"}
          </dd>
        </dl>
      )}
    </>
  );
}
