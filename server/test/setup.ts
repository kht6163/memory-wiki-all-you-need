// Loaded with `node --import ./test/setup.ts` before any test file, so the
// server modules (which read env and open the DB at import time) see a fresh
// temporary data dir and a fake LLM endpoint. node --test runs every test file
// in its own process, so each file gets its own empty database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFakeLlm } from "./llm-stub.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-test-"));
process.env.DATA_DIR = dir;
process.env.LLM_BASE_URL = "http://llm.test/v1";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_MODEL = "test-model";
// Dates (TURN DATE, deadlines) must not depend on the developer's shell.
process.env.TIMEZONE = "UTC";
// The pi extension reads <agent dir>/extensions/memory-wiki-all-you-need.json at import:
// never the developer's real ~/.pi/agent (a "disabled": true there would break the suites).
process.env.PI_CODING_AGENT_DIR = path.join(dir, "pi-agent");
process.env.WEB_DIR = path.join(dir, "web");
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
installFakeLlm(process.env.LLM_BASE_URL);
