// List or delete app releases on the update server.
//
//   npm run releases                          list every APK and live update
//   npm run releases -- --delete web 2.0.1    delete a live update
//   npm run releases -- --delete apk 3.0.0    delete an APK (and its file)
//   npm run releases -- --server http://host:7330
//
// After a delete the server goes back to the newest release left. Phones that
// already run a deleted live update go back to the code inside their APK.
// The same list and delete button are in the Android builder («نسخه‌های روی سرور»).
// See update-server.mjs for the server address and publish key.
import { connect, fail } from "./update-server.mjs";

function show(data) {
  const rows = data.releases || [];
  if (!rows.length) return console.log("No releases on this server.");
  console.log("kind  version   type     current  published            native            web      size");
  for (const r of rows) {
    const when = r.publishedAt ? new Date(r.publishedAt * 1000).toISOString().slice(0, 16).replace("T", " ") : "-";
    const size = `${(r.size / 1048576).toFixed(1)} MB${r.files ? ` (${r.files} files)` : ""}`;
    console.log(`${r.kind.padEnd(5)} ${r.version.padEnd(9)} ${(r.buildType || "release?").padEnd(8)} ${(r.current ? "yes" : "").padEnd(8)} ${when.padEnd(20)} ${r.nativeKey.padEnd(17)} ${String(r.build || "-").slice(0, 8).padEnd(8)} ${size}`);
  }
}

async function main() {
  const { server, call } = connect();
  console.log(`Server ${server}\n`);
  const i = process.argv.indexOf("--delete");
  if (i >= 0) {
    const kind = process.argv[i + 1];
    const version = process.argv[i + 2];
    if (!["apk", "web"].includes(kind) || !/^\d+\.\d+\.\d+$/.test(version || "")) fail("Use: --delete apk|web x.y.z");
    const res = await call("POST", "/app-update/admin/delete", JSON.stringify({ kind, version }));
    if (res.status === 404 && !res.json?.error?.includes("not found")) fail("Server has no release management yet. Deploy the updated server first.");
    if (res.status !== 200) fail(`Delete failed (${res.status}): ${res.json?.error || res.text}`);
    console.log(`✔ Deleted ${kind} ${version}.\n`);
    return show(res.json);
  }
  const res = await call("GET", "/app-update/admin/releases");
  if (res.status === 401) fail("Server rejected the publish key.");
  if (res.status === 404) fail("Server has no release management yet. Deploy the updated server first.");
  if (res.status !== 200) fail(`Server error (${res.status}): ${res.text}`);
  show(res.json);
}

main().catch((error) => fail(error.stack || String(error)));
