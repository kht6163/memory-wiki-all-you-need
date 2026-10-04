# pi-memory-wiki-all-you-need

[memory-wiki-all-you-need](https://github.com/kht6163/memory-wiki-all-you-need) 서버에 붙는 pi 확장입니다.

- 매 요청 전에 서버의 메모리(전역·사용자·이 프로젝트)를 프롬프트에 넣습니다.
- 턴이 끝나면 대화를 서버로 보내고, 서버의 LLM이 메모리를 정리합니다.
- 메모리·위키 도구를 에이전트에게 줍니다.

프로젝트는 git `origin` 주소로 구분합니다. 서버가 꺼져 있거나 느려도 pi 턴을 막지 않습니다(타임아웃 뒤 메모리 없이 진행).

서버가 따로 있어야 합니다. 서버 설치는 [저장소 README](https://github.com/kht6163/memory-wiki-all-you-need#readme)를 보세요.

## 설치

```sh
pi install npm:pi-memory-wiki-all-you-need
```

서버 주소를 환경 변수로 알려 줍니다(셸 설정 파일 등에).

```sh
export MEMORY_SERVER_URL=http://<서버 주소>:8765
```

서버의 `/install.sh`로 이미 설치했다면 `~/.pi/agent/extensions/memory-wiki-all-you-need`를 지운 뒤 npm으로 설치하세요. 둘 다 있으면 확장이 두 번 실행됩니다.

## 환경 변수

| env | 기본값 | 설명 |
|---|---|---|
| `MEMORY_SERVER_URL` | `http://127.0.0.1:8765` | 서버 주소 |
| `MEMORY_SETTLE_DELAY_MS` | 8000 | 턴이 끝나고 서버로 보내기까지 기다리는 시간 |
| `MEMORY_TIMEOUT_MS` | 1500 | 주입할 메모리를 조회하는 타임아웃 |
| `MEMORY_PROJECT` | (자동) | 프로젝트 key를 직접 지정 |
| `MEMORY_DISABLED=1` | | 끄기 |

## 라이선스

MIT
