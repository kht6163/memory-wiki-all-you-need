import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { api } from "./api.ts";
import { config, llmEnabled } from "./config.ts";
import { startWorker } from "./worker.ts";

const app = new Hono();
app.route("/api", api);

// pi extension distribution: `curl -fsSL http://<server>/install.sh | sh`
// copies the extension into ~/.pi/agent/extensions with this server as its
// default MEMORY_SERVER_URL.
const EXTENSION_FILES = ["index.ts", "project.ts"];
const origin = (url: string) => new URL(url).origin;
app.get("/pi-extension/:file", (c) => {
  const file = c.req.param("file");
  if (!EXTENSION_FILES.includes(file)) return c.notFound();
  let src = fs.readFileSync(path.join(config.extensionDir, file), "utf8");
  if (file === "index.ts") src = src.replace("http://127.0.0.1:8765", origin(c.req.url));
  return c.body(src, 200, { "content-type": "text/plain; charset=utf-8" });
});
app.get("/install.sh", (c) => {
  const base = origin(c.req.url);
  const script = `#!/bin/sh
# memory-wiki-all-you-need pi extension installer
set -e
DIR="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/memory-wiki-all-you-need"
mkdir -p "$DIR"
${EXTENSION_FILES.map((f) => `curl -fsSL "${base}/pi-extension/${f}" -o "$DIR/${f}"`).join("\n")}
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

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`memory-wiki-all-you-need listening on http://${info.address}:${info.port}`);
  console.log(`data: ${config.dataDir} | llm: ${llmEnabled() ? `${config.llm.model} @ ${config.llm.baseUrl}` : "disabled"}`);
});
