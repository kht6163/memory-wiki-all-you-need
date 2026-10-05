# pi-memory-wiki-all-you-need

The [pi](https://github.com/earendil-works/pi) extension for [memory-wiki-all-you-need](https://github.com/kht6163/memory-wiki-all-you-need) — a central memory + LLM wiki server for the pi coding agent. ([한국어](https://github.com/kht6163/memory-wiki-all-you-need/blob/main/README.ko.md))

- **Injects memory into every request** — global, user and current-project memories go into the system prompt before each turn, and related memories are recalled per prompt.
- **Curates after each turn** — the finished turn is sent to the server, whose LLM adds, updates or removes memories.
- **Gives the agent tools** — `memory_search`, `session_search`, `memory_add`, `memory_replace`, `memory_remove`, `memory_graph`, `wiki_search`, `wiki_read`, `wiki_write`, plus `/memory`, `/memory-server`, `/memory-pin`, `/memory-flush`, `/wiki-compose`.

Projects are identified by the git `origin` URL. The extension is fail-soft: if the server is down or slow, pi keeps going after a short timeout and reuses the last memory block it received.

You need a running server. See the [main README](https://github.com/kht6163/memory-wiki-all-you-need#readme) for how to set one up.

## Install

```sh
pi install npm:pi-memory-wiki-all-you-need
```

Then point it at your server once, inside pi:

```text
/memory-server http://<server>:8765
```

This saves the URL to `~/.pi/agent/extensions/memory-wiki-all-you-need.json` (under `PI_CODING_AGENT_DIR` if set), where other pi extensions keep their settings too. You can also write the file yourself:

```json
{ "serverUrl": "http://<server>:8765" }
```

Run `/memory-server` without an argument to see the current URL and where it comes from.

If you already installed the extension with the server's `/install.sh`, delete the `~/.pi/agent/extensions/memory-wiki-all-you-need/` folder first (keep the `.json` settings file). With both installed, the extension runs twice.

Update with `pi update`.

## Settings

All keys of `memory-wiki-all-you-need.json` are optional. An environment variable with the same meaning overrides the file.

| Key | Env override | Default | Description |
|---|---|---|---|
| `serverUrl` | `MEMORY_SERVER_URL` | – (set with `/memory-server`) | Server URL |
| `settleDelayMs` | `MEMORY_SETTLE_DELAY_MS` | `8000` | Wait after a turn settles before sending it to the server |
| `timeoutMs` | `MEMORY_TIMEOUT_MS` | `1500` | Timeout for fetching memory to inject |
| `project` | `MEMORY_PROJECT` | (auto) | Override the project key |
| `disabled` | `MEMORY_DISABLED=1` | `false` | Disable the extension |

## License

MIT
