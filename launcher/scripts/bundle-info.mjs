// Live update stamp for the web bundle.
//
// Runs at the end of every `vite build` (plugin in vite.config.ts) and writes
// dist/bundle.json. The app reads it to ask the server for updates, so an APK
// built without it never gets updates.
//   version   - app version x.y.z from package.json (see README: z optional
//               live update, y required live update, x new APK).
//   build     - hash of every file in dist (changes whenever the code does).
//   nativeKey - hash of the native Android code: Capacitor plugin versions,
//               our Java sources (main and the store flavors), AndroidManifest.xml
//               and capacitor.config.json.
//               A phone only takes a live update whose nativeKey matches the
//               APK it has installed; anything else needs a new APK (raise x).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = process.env.MB_ROOT || (fs.existsSync(path.join(process.cwd(), "package.json")) ? process.cwd() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
export const DIST = path.join(ROOT, "dist");
export const INFO_FILE = "bundle.json";
/** Android product flavors, one per store (android/app/build.gradle). */
export const STORE_FLAVORS = ["bazaar", "myket"];

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** Every file of the build except bundle.json, with its SHA-256. */
export function listDistFiles(dist = DIST) {
  return walk(dist)
    .filter((name) => name !== INFO_FILE)
    .map((name) => {
      const data = fs.readFileSync(path.join(dist, name));
      return { name, hash: sha256(data), size: data.length };
    });
}

/** Native packages: dependencies that ship an android/ folder. */
function nativePackages() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return Object.keys(pkg.dependencies || {})
    .sort()
    .filter((name) => fs.existsSync(path.join(ROOT, "node_modules", name, "android")))
    .map((name) => {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8"));
      return `${name}@${p.version}`;
    });
}

/** Same hash on Windows and Linux checkouts (BOM, CRLF). */
const normalizeText = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");

export function computeNativeKey() {
  const parts = nativePackages();
  for (const file of ["capacitor.config.json", "android/app/src/main/AndroidManifest.xml"]) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) parts.push(`${file}:${sha256(normalizeText(fs.readFileSync(full, "utf8")))}`);
  }
  const javaDir = path.join(ROOT, "android", "app", "src", "main", "java");
  if (fs.existsSync(javaDir)) {
    for (const name of walk(javaDir)) parts.push(`${name}:${sha256(fs.readFileSync(path.join(javaDir, name)))}`);
  }
  // Store flavors (Cafe Bazaar / Myket billing). Both folders are hashed, so
  // the Bazaar and the Myket APK of one version share a native key and take
  // the same live updates (the web code does not depend on the store).
  for (const flavor of STORE_FLAVORS) {
    const dir = path.join(ROOT, "android", "app", "src", flavor);
    if (!fs.existsSync(dir)) continue;
    for (const name of walk(dir)) parts.push(`${flavor}/${name}:${sha256(normalizeText(fs.readFileSync(path.join(dir, name), "utf8")))}`);
  }
  return sha256(parts.join("\n")).slice(0, 16);
}

export function appVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

/**
 * buildType ("release" or "test", VITE_BUILD_TYPE of the build) comes from the
 * Vite plugin; later rewrites (publish-update) keep the one in the file.
 * The main server refuses test builds.
 */
export function writeBundleInfo(dist = DIST, { buildType } = {}) {
  const files = listDistFiles(dist);
  const build = sha256(files.map((f) => `${f.name}\0${f.hash}`).join("\n")).slice(0, 16);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(path.join(dist, INFO_FILE), "utf8")); } catch { /* first write */ }
  const type = (buildType || previous.buildType || "release") === "test" ? "test" : "release";
  const info = { version: appVersion(), build, nativeKey: computeNativeKey(), buildType: type };
  fs.writeFileSync(path.join(dist, INFO_FILE), JSON.stringify(info) + "\n");
  return { ...info, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = writeBundleInfo();
  console.log(`bundle ${info.version} ${info.buildType} (build ${info.build}, native ${info.nativeKey}, ${info.files.length} files)`);
}
