# memory-wiki-all-you-need

pi 코딩 에이전트용 중앙 메모리 + 프로젝트 위키. 메모리는 pi-hermes-memory처럼 동작하지만 저장소가 각 PC가 아니라 서버 하나에 있다. 위키는 메모리와 독립된 문서 공간으로, 사람과 에이전트가 쓰고, 요청하면 LLM이 턴 기록을 읽어 페이지로 정리한다.

```
pi (각 PC) ── pi-extension ──HTTP──▶ server (Node 24 + node:sqlite FTS5)
                                      ├─ 턴 큐 ─▶ LLM 메모리 정리 (OpenAI 호환, cli-proxy)
                                      ├─ 위키 정리 작업 (요청 시, 턴 기록 → 페이지)
브라우저 ─────────────────────────────▶ └─ 웹 UI (web/, 같은 포트)
```

## 동작

- **주입 (강제)**: `before_agent_start`마다 서버에서 메모리 블록을 받아 시스템 프롬프트 `memory-context` 섹션에 넣는다. 블록은 정책, 고정 지시, 사용자 프로필, 프로젝트·전역 메모리 순(예산 `CONTEXT_BUDGET_CHARS`). 메모리가 바뀔 때만 내용이 바뀌어 프롬프트 캐시가 유지된다. 이번 프롬프트와 관련된 나머지 메모리는 숨은 메시지(`memory-recall`)로 붙는다. 서버가 응답하지 않으면 직전 블록을 쓴다.
- **턴 정리**: `message_end`로 턴을 모으고, `agent_settled`(재시도·압축·대기 작업까지 끝난 완전 대기) 후 `MEMORY_SETTLE_DELAY_MS`(기본 8초) 지나면 서버로 보낸다. 그 사이 새 프롬프트가 오면 합쳐서 나중에 보낸다. 종료 시(`session_shutdown`)에는 즉시 보낸다. 서버는 턴마다 관련 기존 메모리를 함께 LLM에 보여주고 add/update/delete를 받아 바로 반영한다(모든 변경은 이력에 남고 되돌릴 수 있음).
- **프로젝트 구분 (클라이언트)**: cwd가 속한 git 저장소(worktree는 메인 저장소)의 `origin` 주소를 정규화해 키로 쓴다(`github.com/foo/bar`). 원격이 없으면 `local/<폴더명>`, git 밖이면 전역만. `MEMORY_PROJECT`로 덮어쓸 수 있다.
- **도구**: `memory_search`, `session_search`, `memory_add`, `memory_replace`, `memory_remove` (pi-hermes-memory와 같은 이름·target), `wiki_search`, `wiki_read`, `wiki_write`.
- **명령**: `/memory`(상태·위키 링크), `/memory-pin <text> [--project]`(고정 지시), `/memory-flush`, `/wiki-compose [정리 방향]`(현재 세션의 턴을 위키로 정리).
- **위키 (메모리와 독립)**: 프로젝트별 위키와 전역 위키. 페이지는 `[[slug]]`로 잇고, 필요하면 `[#id]`로 메모리를 참조한다(링크일 뿐 동기화하지 않음). 이력·되돌리기·백링크·검색·잠금을 지원한다. pi에는 페이지 목록만 주입되고 `wiki_search`/`wiki_read`로 읽으며, 사용자가 요청하면 `wiki_write`로 쓴다.
- **턴 기록으로 위키 정리**: 웹의 "턴 기록으로 정리"에서 턴을 고르거나(기본: 이 위키에 아직 정리 안 된 턴) pi에서 `/wiki-compose`를 실행하면, LLM이 대화와 도구 실행 결과를 읽고 남길 만한 내용(구조, 결정과 이유, 절차, 문제 해결)을 페이지에 반영한다. 자동으로는 돌지 않는다. 턴이 많으면 `WIKI_COMPOSE_CHUNK_CHARS` 단위로 나눠 차례로 처리하므로 한 번의 LLM 호출 크기는 위키·기록 규모와 무관하다. 잠근 페이지와 이번 호출에서 본문을 보지 못한 페이지는 고치지 않는다.
- **보호**: 비밀값처럼 보이는 내용은 저장 거부, 턴 기록에서는 가림. 고정 지시(`standing`)는 사람만 쓰고 고칠 수 있다.

## 메모리 모델

| 필드 | 값 |
|---|---|
| scope | `global` / `user` / `project` |
| category | `standing` `convention` `decision` `fact` `preference` `correction` `failure` `tool-quirk` `insight` |
| source | `human` / `llm` / `agent` (마지막 작성자) |

## 설치

서버 (docker compose 예시, `LLM_API_KEY`는 `.env`에):

```yaml
services:
  memory:
    build: ./memory-wiki-all-you-need   # 이 저장소
    restart: unless-stopped
    environment:
      LLM_BASE_URL: http://<llm-host>:8317/v1
      LLM_API_KEY: ${LLM_API_KEY:?missing}
      LLM_MODEL: gpt-6-luna
    ports:
      - "127.0.0.1:8765:8765"   # 로그인이 없으므로 신뢰하는 네트워크에만 바인딩
    volumes:
      - ./data:/data
```

| env | 기본값 | |
|---|---|---|
| `LLM_BASE_URL` | – | OpenAI 호환 `/v1` 주소. 없으면 턴은 저장만 하고 정리는 건너뜀 |
| `LLM_API_KEY`, `LLM_MODEL` | –, `gpt-6-luna` | |
| `CONTEXT_BUDGET_CHARS` | 8000 | 시스템 프롬프트 메모리 블록 예산 |
| `RECALL_BUDGET_CHARS`, `RECALL_LIMIT` | 3000, 6 | 프롬프트별 회상 |
| `WIKI_COMPOSE_CHUNK_CHARS` | 40000 | 위키 정리 시 LLM 호출 1회에 넣는 턴 기록 글자 수 |
| `WIKI_COMPOSE_MAX_TURNS` | 200 | 정리 작업 1건의 최대 턴 수 |
| `WIKI_WRITER_BUDGET_CHARS` | 40000 | 정리 호출 1회에 보여주는 기존 페이지 본문 예산 |

pi (각 PC):

```sh
curl -fsSL http://<서버 주소>:8765/install.sh | sh   # ~/.pi/agent/extensions/memory-wiki-all-you-need
```

| env | 기본값 |
|---|---|
| `MEMORY_SERVER_URL` | 설치한 서버 주소 |
| `MEMORY_SETTLE_DELAY_MS` | 8000 |
| `MEMORY_TIMEOUT_MS` | 1500 (주입 조회 타임아웃) |
| `MEMORY_PROJECT` | (자동) |
| `MEMORY_DISABLED=1` | 끄기 |

## 개발

```sh
npm install
npm run dev:server          # :8765 (PORT, DATA_DIR 로 변경)
npm run dev:web             # vite, /api 는 API_URL(기본 127.0.0.1:8765) 로 프록시
npm run typecheck
```
