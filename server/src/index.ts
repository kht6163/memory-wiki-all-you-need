import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { api } from "./api.ts";
import { config, embedEnabled, llmEnabled } from "./config.ts";
import { captureConsole, debugState, pruneDebugLogs } from "./debug-log.ts";
import { wikiComposeState } from "./settings.ts";
import { startEmbedder } from "./embeddings.ts";
import { startWorker } from "./worker.ts";

// Debug mode also keeps the console in the day file (ADR-0035); old day files go at startup.
captureConsole();
pruneDebugLogs();

const app = new Hono();
app.route("/api", api);

// pi extension distribution: `curl -fsSL http://<server>/install.sh | sh`
// copies the extension into ~/.pi/agent/extensions, writes this server as
// "serverUrl" into its settings file (other keys kept), and serves index.ts
// with this server as the built-in default (G-008).
const EXTENSION_FILES = ["index.ts", "project.ts", "skills.ts"];
const origin = (url: string) => new URL(url).origin;
app.get("/pi-extension/:file", (c) => {
  const file = c.req.param("file");
  if (!EXTENSION_FILES.includes(file)) return c.notFound();
  let src = fs.readFileSync(path.join(config.extensionDir, file), "utf8");
  if (file === "index.ts") src = src.replace("http://127.0.0.1:8765", origin(c.req.url));
  return c.body(src, 200, { "content-type": "text/plain; charset=utf-8" });
});
// Sets "serverUrl" in the extension's settings file and keeps every other key.
// A file that is not a JSON object is left alone (no silent overwrite).
const SET_SERVER_URL = [
  `const fs = require("fs"), [file, url] = process.argv.slice(1);`,
  `let c = {};`,
  `if (fs.existsSync(file)) {`,
  `  try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { c = null; }`,
  `  if (!c || typeof c !== "object" || Array.isArray(c)) { console.log("not changed (not a JSON object): " + file); process.exit(0); }`,
  `}`,
  `c.serverUrl = url;`,
  `fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\\n");`,
  `console.log("server URL saved to " + file);`,
].join(" ");
app.get("/install.sh", (c) => {
  const base = origin(c.req.url);
  const script = `#!/bin/sh
# memory-wiki-all-you-need pi extension installer
set -e
DIR="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/memory-wiki-all-you-need"
mkdir -p "$DIR"
${EXTENSION_FILES.map((f) => `curl -fsSL "${base}/pi-extension/${f}" -o "$DIR/${f}"`).join("\n")}
CONF="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/memory-wiki-all-you-need.json"
if command -v node >/dev/null 2>&1; then
  node -e '${SET_SERVER_URL}' "$CONF" "${base}"
else
  echo 'node not found: put {"serverUrl": "${base}"} in this file yourself:' "$CONF"
fi
echo "installed to $DIR (server: ${base})"
echo "restart pi (or run /reload) to load it"
`;
  return c.body(script, 200, { "content-type": "text/x-shellscript; charset=utf-8" });
});

if (fs.existsSync(config.webDir)) {
  const root = path.relative(process.cwd(), config.webDir) || ".";
  app.use("/assets/*", serveStatic({ root }));
  app.use("/favicon.svg", serveStatic({ root }));
  const index = fs.readFileSync(path.join(config.webDir, "index.html"), "utf8");
  app.get("*", (c) => c.html(index));
} else {
  app.get("/", (c) => c.text(`web UI not built (${config.webDir})`));
}

startWorker();
startEmbedder();

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`memory-wiki-all-you-need listening on http://${info.address}:${info.port}`);
  console.log(`data: ${config.dataDir} | llm: ${llmEnabled() ? `${config.llm.model} @ ${config.llm.baseUrl}` : "disabled"} | embeddings: ${embedEnabled() ? `${config.embed.model} @ ${config.embed.baseUrl}` : "off"} | wiki compose: ${wikiComposeState().enabled ? "on" : "off"} (${wikiComposeState().source}) | debug: ${debugState().enabled ? `on (${debugState().source}) → ${config.debug.logDir}` : "off"}`);
});
