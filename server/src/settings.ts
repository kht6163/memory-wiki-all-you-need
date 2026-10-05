import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

// Feature switches set from the web (ADR-0038), kept in <DATA_DIR>/settings.json.
// Same precedence as debug mode and the extension settings (ADR-0033, ADR-0035):
// an env var wins over the file, the file over the default. Debug mode keeps its
// own debug.json.
//  - wikiCompose (WIKI_COMPOSE): the server LLM organizing turn records into wiki
//    pages (POST /wiki/compose). Off = no new or retried compose jobs and the
//    worker leaves queued ones waiting (G-067). On by default. Agent and person
//    page writes are not affected.

export type SettingSource = "env" | "file" | "default";
export interface SwitchState {
  enabled: boolean;
  source: SettingSource;
}

const file = () => path.join(config.dataDir, "settings.json");
let cache: Record<string, unknown> | undefined;

function readFile(): Record<string, unknown> {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

const saved = () => (cache ??= readFile());

export function wikiComposeState(): SwitchState {
  if (config.wiki.composeEnv !== undefined) return { enabled: config.wiki.composeEnv, source: "env" };
  const v = saved().wikiCompose;
  return typeof v === "boolean" ? { enabled: v, source: "file" } : { enabled: true, source: "default" };
}

export const wikiComposeEnabled = () => wikiComposeState().enabled;

export class SettingForcedError extends Error {
  constructor(env: string) {
    super(`this setting is fixed by ${env}`);
  }
}

let onChange: (() => void) | null = null;
/** The worker wakes up when compose is switched back on (queued jobs can run). */
export function onSettingsChanged(fn: () => void) {
  onChange = fn;
}

/** Turns wiki compose on or off (persisted). Throws when WIKI_COMPOSE fixes it. */
export function setWikiCompose(enabled: boolean): SwitchState {
  if (config.wiki.composeEnv !== undefined) throw new SettingForcedError("WIKI_COMPOSE");
  const next = { ...readFile(), wikiCompose: enabled };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
  onChange?.();
  return wikiComposeState();
}

/** Tests: forget the cached file. */
export function resetSettings() {
  cache = undefined;
}
