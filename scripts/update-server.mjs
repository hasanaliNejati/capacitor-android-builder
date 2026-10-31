// Shared helpers for publish-update.mjs and publish-apk.mjs: talk to the
// game server's /app-update endpoints with the publish key.
//
// Server address: --server http://host:port, else VITE_NAKAMA_HTTP_URL from .env.android.
// Publish key: APP_UPDATE_PUBLISH_KEY from the environment or .env.publish.local.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = process.env.MB_ROOT || (fs.existsSync(path.join(process.cwd(), "package.json")) ? process.cwd() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const CHUNK = 64 * 1024; // must stay below the server's request size limit

export function readEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* optional file */ }
  return out;
}

export function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

export function connect() {
  const server = (arg("--server") || readEnv(".env.android").VITE_NAKAMA_HTTP_URL || "").replace(/\/$/, "");
  const key = process.env.APP_UPDATE_PUBLISH_KEY || readEnv(".env.publish.local").APP_UPDATE_PUBLISH_KEY;
  if (!/^https?:\/\//.test(server)) fail("Server address not found. Pass --server http://host:port or set VITE_NAKAMA_HTTP_URL in .env.android.");
  if (!key) fail("Publish key not found. Put APP_UPDATE_PUBLISH_KEY=... in .env.publish.local.");

  async function call(method, urlPath, body, contentType = "application/json") {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(server + urlPath, {
          method,
          headers: { "X-Publish-Key": key, "Content-Type": contentType },
          body,
          signal: AbortSignal.timeout(60000),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text };
      } catch (error) {
        if (attempt >= 4) throw error;
        console.warn(`  network error (${error.message}), retrying...`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  /** Uploads files ({hash, size, read()}) the server does not have yet. */
  async function uploadMissing(files) {
    const unique = [...new Map(files.map((f) => [f.hash, f])).values()];
    const res = await call("POST", "/app-update/publish/missing", JSON.stringify({ hashes: unique.map((f) => f.hash) }));
    if (res.status === 401) fail("Server rejected the publish key.");
    if (res.status === 404) fail("Server has no /app-update endpoint. Deploy the updated server first.");
    if (res.status !== 200) fail(`Server error (${res.status}): ${res.text}`);
    const missing = new Set(res.json.missing);
    const todo = unique.filter((f) => missing.has(f.hash));
    const bytes = todo.reduce((n, f) => n + f.size, 0);
    console.log(`Uploading ${todo.length} new files (${(bytes / 1048576).toFixed(1)} MB)...`);
    let done = 0;
    for (const file of todo) {
      const data = file.read();
      let offset = 0;
      do {
        const chunk = data.subarray(offset, offset + CHUNK);
        const r = await call("PUT", `/app-update/publish/chunk?hash=${file.hash}&size=${data.length}&offset=${offset}`, chunk, "application/octet-stream");
        if (r.status === 409 && typeof r.json?.received === "number") {
          offset = r.json.received; // resume where the server is
          continue;
        }
        if (r.status !== 200) fail(`Upload of ${file.name} failed (${r.status}): ${r.text}`);
        offset = r.json.received;
      } while (offset < data.length);
      done++;
      process.stdout.write(`\r  ${done}/${todo.length}  ${String(file.name).slice(-60).padEnd(60)}`);
    }
    if (todo.length) process.stdout.write("\n");
  }

  async function publish(urlPath, body) {
    const res = await call("POST", urlPath, JSON.stringify(body));
    if (res.status !== 200) fail(`Publish rejected (${res.status}): ${res.json?.error || res.text}`);
  }

  return { server, call, uploadMissing, publish };
}
