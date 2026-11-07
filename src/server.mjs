// Menchat Android Builder — sets the app's name, id, version, icon, orientation and store
// (Cafe Bazaar / Myket / both), then builds the debug APK(s) and installs/runs it on a USB phone. Normally started by MenchatBuilder.exe, which
// passes MB_ROOT (project), MB_DATA (settings folder), MB_UI (folder with index.html) and PORT.
// Can also be run directly: node android-builder/src/server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const UI = process.env.MB_UI || HERE;
const ROOT = process.env.MB_ROOT || process.cwd();
const DATA = process.env.MB_DATA || path.join(ROOT, "android-builder");
const IS_WIN = process.platform === "win32";
const VERSION = "1.7.1";
const CONFIG_FILE = path.join(DATA, "settings.json");
const ICON_DIR = path.join(DATA, "icon");
const ANDROID = path.join(ROOT, "android");
const ARTIFACTS = path.join(ROOT, "artifacts");
const LOG_FILE = path.join(ARTIFACTS, "android-builder.log");

function resolveAsset(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return "";
}

function getFontPath() {
  return resolveAsset([
    path.join(ROOT, "public", "assets", "fonts", "pofak", "PofakVF.woff2"),
    path.join(PKG_ROOT, "src", "assets", "PofakVF.woff2"),
  ]);
}

function getFaviconPath() {
  // The builder's own dice icon, not the project's app icon.
  return resolveAsset([path.join(PKG_ROOT, "src", "assets", "icon.png")]);
}

function getAppSlug(cfg) {
  if (cfg?.appSlug) return cfg.appSlug;
  const cap = readCapacitorConfig();
  const id = cfg?.appId || cap.appId || "";
  if (id.includes("menchat")) return "menchat";
  if (id) {
    const parts = id.split(".");
    return parts[parts.length - 1] || "app";
  }
  return "app";
}

// ---------- config ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}
function readEnvUrl() {
  try {
    const m = fs.readFileSync(path.join(ROOT, ".env.android"), "utf8").match(/^VITE_NAKAMA_HTTP_URL=(.*)$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}
function readUpdateServerUrl() {
  try {
    const m = fs.readFileSync(path.join(ROOT, ".env.android"), "utf8").match(/^VITE_UPDATE_SERVER_URL=(.*)$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}
function readCapacitorConfig() {
  const jsonPath = path.join(ROOT, "capacitor.config.json");
  if (fs.existsSync(jsonPath)) return readJson(jsonPath, {});
  for (const name of ["capacitor.config.ts", "capacitor.config.js", "capacitor.config.mjs"]) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8");
      const appIdMatch = text.match(/appId\s*:\s*["'`]([^"'`]+)["'`]/);
      const appNameMatch = text.match(/appName\s*:\s*["'`]([^"'`]+)["'`]/);
      return {
        appId: appIdMatch ? appIdMatch[1] : undefined,
        appName: appNameMatch ? appNameMatch[1] : undefined,
      };
    }
  }
  return {};
}

function defaults() {
  const cap = readCapacitorConfig();
  return {
    appName: cap.appName || "منچت",
    appId: cap.appId || "com.menchat.react",
    versionName: readJson(path.join(ROOT, "package.json"), {}).version || "1.0.0",
    versionCode: 1,
    autoIncrement: true,
    lastBuiltCode: 0,
    orientation: "portrait",
    serverUrl: readEnvUrl(),
    updateServerUrl: readUpdateServerUrl(),
    buildType: "test",
    iconBackground: "#073773",
    iconScale: 100,
    hasIcon: false,
    device: "",
    useMirrors: true,
    proxyMode: "auto",
    proxyAddress: "127.0.0.1:10808",
    jdkPath: "",
    sdkPath: "",
    stores: ["bazaar"],
    signWith: "debug",
    directApkDownload: false,
    bazaarRsaKey: "",
    myketRsaKey: "",
    publishTargetServer: "",
    dualPublish: false,
  };
}
function loadConfig() {
  const cfg = { ...defaults(), ...readJson(CONFIG_FILE, {}) };
  cfg.hasIcon = fs.existsSync(path.join(ICON_DIR, "source.png"));
  // The app version lives only in package.json (app updates read it from there).
  cfg.versionName = appVersion();
  cfg.publishKeySet = !!readPublishKey();
  cfg.stores = normalizeStores(cfg.stores);
  cfg.signWith = cfg.signWith === "release" ? "release" : "debug";
  cfg.signing = signingStatus();
  return cfg;
}
function saveConfig(cfg) {
  fs.mkdirSync(DATA, { recursive: true });
  const { hasIcon, versionName, publishKeySet, signing, ...rest } = cfg;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(rest, null, 2) + "\n");
}

// ---------- stores (in-app purchases) ----------
// One Android product flavor per store (android/app/build.gradle). Each APK
// has only its own store's billing plugin and library.
const STORES = {
  bazaar: { name: "کافه‌بازار", gradle: "Bazaar" },
  myket: { name: "مایکت", gradle: "Myket" },
};
function normalizeStores(list) {
  const out = Object.keys(STORES).filter((s) => Array.isArray(list) && list.includes(s));
  return out.length ? out : ["bazaar"];
}
const storeNames = (stores) => stores.map((s) => STORES[s].name).join(" و ");
/** APK of {store} in artifacts/ for this version. */
const apkName = (cfg, store, nKey = "", wKey = "") => `${getAppSlug(cfg)}-${store}-${cfg.versionName}-${cfg.versionCode}${nKey ? `-n${String(nKey).slice(0, 8)}` : ""}${wKey ? `-w${String(wKey).slice(0, 8)}` : ""}${isTestBuild(cfg) ? "-test" : ""}.apk`;

// ---------- test builds: own app ID and name ----------
// A test build (Custom Connect menu, test tools) installs next to the real
// game: ID <appId>.dev, name «<appName> تست». Only the Android project gets
// these; capacitor.config.json keeps the real ones, so test and release
// builds share one native key.
const isTestBuild = (cfg) => cfg.buildType !== "release";
const nativeAppId = (cfg) => (isTestBuild(cfg) ? `${cfg.appId}.dev` : cfg.appId);
const nativeAppName = (cfg) => (isTestBuild(cfg) ? `${cfg.appName} تست` : cfg.appName);
const cleanKey = (k) => String(k || "").replace(/\s+/g, "");
/** android/app/store.properties: RSA public keys read by app/build.gradle. */
function writeStoreKeys(cfg) {
  fs.writeFileSync(path.join(ANDROID, "app", "store.properties"),
    `# generated by Menchat Android Builder (RSA public keys of in-app billing)\nbazaarRsaKey=${cleanKey(cfg.bazaarRsaKey)}\nmyketRsaKey=${cleanKey(cfg.myketRsaKey)}\n`);
}

// ---------- release signing key (keystore) ----------
// The key and its passwords stay on this computer in android-builder/signing/
// (git-ignored). For a release build the builder writes
// android/keystore.properties (git-ignored), read by app/build.gradle.
const SIGNING_DIR = path.join(DATA, "signing");
const SIGNING_KEY = path.join(SIGNING_DIR, "release.keystore");
const SIGNING_INFO = path.join(SIGNING_DIR, "signing.json");
const KEYSTORE_PROPS = path.join(ANDROID, "keystore.properties");
function readSigning() {
  const info = readJson(SIGNING_INFO, null);
  return info && exists(SIGNING_KEY) ? info : null;
}
/** What the page may see: no passwords. */
function signingStatus() {
  const s = readSigning();
  return s ? { set: true, fileName: s.fileName, alias: s.alias, sha256: s.sha256, owner: s.owner, savedAt: s.savedAt } : { set: false };
}
/** Runs a JDK tool without a shell; passwords go through env (-storepass:env). */
function jdkTool(jdk, name, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const exe = path.join(jdk.path, "bin", IS_WIN ? `${name}.exe` : name);
    const child = spawn(exe, args, { env: { ...process.env, ...extraEnv }, windowsHide: true });
    child.stdin.end(); // never wait for a typed password
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: -1, out: e.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}
/** SHA-256 of the certificate an APK is signed with (lowercase hex), or "". */
async function apkCertSha256(jdk, sdk, apk) {
  const tools = [...(sdk?.buildTools || [])].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const jar = tools.map((v) => path.join(sdk.path, "build-tools", v, "lib", "apksigner.jar")).find(exists);
  if (!jdk || !jar) return "";
  const r = await jdkTool(jdk, "java", ["-jar", jar, "verify", "--print-certs", apk]);
  return ((r.out.match(/certificate SHA-256 digest:\s*([0-9a-f]{64})/i) || [])[1] || "").toLowerCase();
}
/** Key aliases inside a keystore. Listing needs no password (JKS and PKCS12). */
async function listAliases(file) {
  const jdk = detectJdk(loadConfig());
  if (!jdk) throw new Error("JDK پیدا نشد؛ برای خواندن کلید لازم است.");
  const r = await jdkTool(jdk, "keytool", ["-list", "-v", "-keystore", file]);
  const entries = [...r.out.matchAll(/^Alias name:\s*(.+?)\s*$[\s\S]*?^Entry type:\s*(\S+)/gm)].map((m) => ({ alias: m[1], type: m[2] }));
  if (!entries.length) {
    if (/Unrecognized keystore format|Invalid keystore format|not a valid|Keystore file does not exist/i.test(r.out)) throw new Error("این فایل keystore معتبر نیست.");
    return [];
  }
  const keys = entries.filter((e) => /PrivateKeyEntry/i.test(e.type)).map((e) => e.alias);
  return keys.length ? keys : entries.map((e) => e.alias);
}
/** Checks file + alias + both passwords; returns the certificate's SHA-256 and owner. */
async function verifyKeystore(file, alias, storePassword, keyPassword) {
  const jdk = detectJdk(loadConfig());
  if (!jdk) throw new Error("JDK پیدا نشد؛ برای بررسی کلید لازم است.");
  const env = { MB_STOREPASS: storePassword, MB_KEYPASS: keyPassword };
  const list = await jdkTool(jdk, "keytool", ["-list", "-v", "-keystore", file, "-alias", alias, "-storepass:env", "MB_STOREPASS"], env);
  if (list.code !== 0) {
    if (/password was incorrect|keystore password was incorrect|Keystore was tampered/i.test(list.out)) throw new Error("رمز keystore اشتباه است.");
    if (/Alias <.*> does not exist/i.test(list.out)) throw new Error(`alias «${alias}» در این فایل نیست.`);
    if (/Unrecognized keystore format|Invalid keystore format|not a valid/i.test(list.out)) throw new Error("این فایل keystore معتبر نیست.");
    throw new Error("کلید باز نشد: " + list.out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // keytool -list does not check the key password: sign a tiny jar with it.
  // PKCS12 keystores (the default since Java 9) have no separate key
  // password, so the keystore password is tried too.
  let workingKeyPassword = keyPassword;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-sign-"));
  try {
    fs.writeFileSync(path.join(tmp, "a.txt"), "menchat");
    const jar = path.join(tmp, "check.jar");
    const made = await jdkTool(jdk, "jar", ["cf", jar, "-C", tmp, "a.txt"]);
    if (made.code === 0) {
      const sign = (kp) => jdkTool(jdk, "jarsigner", ["-keystore", file, "-storepass:env", "MB_STOREPASS", "-keypass:env", "MB_KEYPASS", jar, alias], { MB_STOREPASS: storePassword, MB_KEYPASS: kp });
      let signed = await sign(keyPassword);
      if (signed.code !== 0 && keyPassword !== storePassword) {
        const retry = await sign(storePassword);
        if (retry.code === 0) { signed = retry; workingKeyPassword = storePassword; }
      }
      if (signed.code !== 0) {
        throw new Error(/password|Cannot recover key|not a private key/i.test(signed.out)
          ? "رمز کلید (key password) اشتباه است."
          : "امضای آزمایشی با این کلید نشد: " + signed.out.trim().split(/\r?\n/).slice(-1)[0]);
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const sha256 = (list.out.match(/SHA256:\s*([0-9A-F:]+)/i) || [])[1] || "";
  const owner = ((list.out.match(/Owner:\s*(.+)/i) || [])[1] || "").trim();
  return { sha256, owner, keyPassword: workingKeyPassword };
}
async function saveSigning({ file, fileName, alias, storePassword, keyPassword }) {
  alias = String(alias || "").trim();
  storePassword = String(storePassword || "");
  keyPassword = String(keyPassword || "") || storePassword;
  const old = readSigning();
  if (!file && !old) throw new Error("فایل keystore را انتخاب کن.");
  if (!storePassword && old) { storePassword = old.storePassword; if (!keyPassword || keyPassword === "") keyPassword = old.keyPassword; }
  if (!storePassword) throw new Error("رمز keystore را وارد کن.");
  fs.mkdirSync(SIGNING_DIR, { recursive: true });
  const candidate = file ? path.join(SIGNING_DIR, "candidate.keystore") : SIGNING_KEY;
  if (file) fs.writeFileSync(candidate, file);
  try {
    if (!alias) {
      // Empty alias: take it from the keystore when it holds one key.
      const aliases = await listAliases(candidate);
      if (aliases.length === 1) alias = aliases[0];
      else if (aliases.length > 1) throw new Error(`این فایل چند کلید دارد (${aliases.join("، ")})؛ alias را انتخاب کن.`);
      else throw new Error("کلیدی در این فایل پیدا نشد.");
    }
    const checked = await verifyKeystore(candidate, alias, storePassword, keyPassword);
    const { sha256, owner } = checked;
    keyPassword = checked.keyPassword;
    if (file) fs.renameSync(candidate, SIGNING_KEY);
    fs.writeFileSync(SIGNING_INFO, JSON.stringify({ fileName: fileName || old?.fileName || "release.keystore", alias, storePassword, keyPassword, sha256, owner, savedAt: Date.now() }, null, 2));
    return signingStatus();
  } finally {
    if (file && exists(candidate)) fs.rmSync(candidate, { force: true });
  }
}
function clearSigning() {
  fs.rmSync(SIGNING_DIR, { recursive: true, force: true });
  fs.rmSync(KEYSTORE_PROPS, { force: true });
}
/** android/keystore.properties for a release build (values escaped for .properties). */
function writeKeystoreProps() {
  const s = readSigning();
  if (!s) throw new Error("برای امضا با «کلید خودمان» اول در بخش «کلید امضا» فایل keystore را ثبت کن.");
  const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/\r?\n/g, "").replace(/^\s/, "\\ ");
  fs.writeFileSync(KEYSTORE_PROPS, [
    "# generated by Menchat Android Builder (release signing; do not commit)",
    `storeFile=${esc(SIGNING_KEY.replace(/\\/g, "/"))}`,
    `storePassword=${esc(s.storePassword)}`,
    `keyAlias=${esc(s.alias)}`,
    `keyPassword=${esc(s.keyPassword)}`,
    "",
  ].join("\n"));
}

// ---------- app version (package.json) and update publishing ----------
// x.y.z: z = optional live update, y = required live update, x = new APK.
// See AGENTS.md and README ("آپدیت خودکار").
const PACKAGE_FILE = path.join(ROOT, "package.json");
const PUBLISH_KEY_FILE = path.join(ROOT, ".env.publish.local");
const VERSION_RE = /^\d+\.\d+\.\d+$/;
function appVersion() { return readJson(PACKAGE_FILE, {}).version || "0.0.0"; }
function setAppVersion(version) {
  if (!VERSION_RE.test(version)) throw new Error(`نسخه باید به شکل x.y.z باشد (مثل 1.2.3)، نه «${version}»`);
  const text = fs.readFileSync(PACKAGE_FILE, "utf8");
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next !== text) fs.writeFileSync(PACKAGE_FILE, next);
}
function nextVersion(part, version = appVersion()) {
  const [x, y, z] = version.split(".").map(Number);
  return part === "x" ? `${x + 1}.0.0` : part === "y" ? `${x}.${y + 1}.0` : `${x}.${y}.${z + 1}`;
}
// Like the publish scripts: the environment wins over .env.publish.local.
function readPublishKey() {
  if (process.env.APP_UPDATE_PUBLISH_KEY) return process.env.APP_UPDATE_PUBLISH_KEY.trim();
  try { return (fs.readFileSync(PUBLISH_KEY_FILE, "utf8").match(/^APP_UPDATE_PUBLISH_KEY=(.*)$/m) || [])[1]?.trim() || ""; } catch { return ""; }
}
function writePublishKey(key) {
  let s = exists(PUBLISH_KEY_FILE) ? fs.readFileSync(PUBLISH_KEY_FILE, "utf8") : "";
  if (/^APP_UPDATE_PUBLISH_KEY=.*$/m.test(s)) s = s.replace(/^APP_UPDATE_PUBLISH_KEY=.*$/m, `APP_UPDATE_PUBLISH_KEY=${key}`);
  else s = s.replace(/\n?$/, "\n") + `APP_UPDATE_PUBLISH_KEY=${key}\n`;
  fs.writeFileSync(PUBLISH_KEY_FILE, s.replace(/^\n/, ""));
}
/** Hash of the native Android code, same as scripts/bundle-info.mjs. */
async function nativeKey() {
  const { pathToFileURL } = await import("node:url");
  const scriptPath = [
    path.join(ROOT, "scripts", "bundle-info.mjs"),
    path.join(PKG_ROOT, "scripts", "bundle-info.mjs"),
  ].find(fs.existsSync);
  if (!scriptPath) return "";
  const mod = await import(pathToFileURL(scriptPath).href);
  return mod.computeNativeKey();
}

// ---------- toolchain detection ----------
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function javaMajor(home) {
  try {
    const m = fs.readFileSync(path.join(home, "release"), "utf8").match(/JAVA_VERSION="(\d+)(?:\.(\d+))?/);
    if (!m) return 0;
    return m[1] === "1" ? Number(m[2]) : Number(m[1]);
  } catch { return 0; }
}
function listDirs(base, prefixes) {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && prefixes.some((p) => d.name.toLowerCase().startsWith(p)))
      .map((d) => path.join(base, d.name));
  } catch { return []; }
}
function detectJdk(cfg) {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    cfg.jdkPath, process.env.JAVA_HOME,
    path.join(pf, "Android", "Android Studio", "jbr"),
    local && path.join(local, "Programs", "Android Studio", "jbr"),
    ...["Eclipse Adoptium", "Microsoft", "Java", "Zulu", "Amazon Corretto", "BellSoft"]
      .flatMap((v) => listDirs(path.join(pf, v), ["jdk", "zulu", "liberica"])),
    ...listDirs("/usr/lib/jvm", ["java-", "jdk", "openjdk"]),
  ].filter(Boolean);
  const javac = IS_WIN ? "javac.exe" : "javac";
  const found = [];
  for (const c of [...new Set(candidates)]) {
    if (!exists(path.join(c, "bin", javac))) continue;
    found.push({ path: c, version: javaMajor(c) });
  }
  if (cfg.jdkPath) {
    const own = found.find((f) => f.path === cfg.jdkPath);
    if (own) return own;
  }
  const ok = found.filter((f) => f.version >= 21).sort((a, b) => a.version - b.version);
  return ok[0] || found[0] || null;
}
function detectSdk(cfg) {
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    cfg.sdkPath, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    local && path.join(local, "Android", "Sdk"),
    "C:\\Android\\Sdk", "C:\\Android",
    process.env.HOME && path.join(process.env.HOME, "Android", "Sdk"),
  ].filter(Boolean);
  const sdk = candidates.find((c) => exists(path.join(c, "platforms")));
  if (!sdk) return null;
  const list = (d) => { try { return fs.readdirSync(path.join(sdk, d)); } catch { return []; } };
  return { path: sdk, platforms: list("platforms"), buildTools: list("build-tools") };
}
function adbPath(sdk) {
  if (!sdk) return null;
  const p = path.join(sdk.path, "platform-tools", IS_WIN ? "adb.exe" : "adb");
  return exists(p) ? p : null;
}
function toolEnv(jdk, sdk) {
  const env = { ...process.env };
  const sep = IS_WIN ? ";" : ":";
  if (jdk) { env.JAVA_HOME = jdk.path; env.PATH = path.join(jdk.path, "bin") + sep + (env.PATH || env.Path || ""); if (IS_WIN) env.Path = env.PATH; }
  if (sdk) { env.ANDROID_HOME = sdk.path; env.ANDROID_SDK_ROOT = sdk.path; }
  return env;
}

// ---------- network / gradle ----------
function probe(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 700 }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}
// v2rayN: 10808 (mixed/socks) and 10809 (http); Clash: 7890; others: 2080, 1080
const AUTO_PORTS = [[10809, "http"], [10808, "http"], [7890, "http"], [2080, "http"], [1080, "socks"]];
async function resolveProxy(cfg) {
  if (cfg.proxyMode === "none") return null;
  if (cfg.proxyMode === "http" || cfg.proxyMode === "socks") {
    const [host, port] = String(cfg.proxyAddress || "").replace(/^\w+:\/\//, "").split(":");
    if (!Number(port)) return null;
    return { type: cfg.proxyMode, host: host || "127.0.0.1", port: Number(port), up: await probe(Number(port), host || "127.0.0.1") };
  }
  for (const [port, type] of AUTO_PORTS) if (await probe(port)) return { type, host: "127.0.0.1", port, up: true, auto: true };
  return null;
}
function proxyProps(p) {
  if (!p) return [];
  if (p.type === "socks") return [["socksProxyHost", p.host], ["socksProxyPort", p.port]];
  return [["http.proxyHost", p.host], ["http.proxyPort", p.port], ["https.proxyHost", p.host], ["https.proxyPort", p.port]];
}
const vparts = (v) => v.split(".").map(Number);
function vcmp(a, b) { const x = vparts(a), y = vparts(b); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
// Gradle keeps each wrapper download in wrapper/dists/<dist>/<hash>, where <hash> is the base-36 MD5 of the
// distribution URL. To reuse a copy we must point distributionUrl at the exact URL it was downloaded from.
function gradleUrlHash(url) {
  return BigInt("0x" + crypto.createHash("md5").update(url, "utf8").digest("hex")).toString(36);
}
function cachedGradles() {
  const home = process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle");
  const dists = path.join(home, "wrapper", "dists");
  const out = [];
  try {
    for (const name of fs.readdirSync(dists)) {
      const m = name.match(/^gradle-(\d+\.\d+(?:\.\d+)?)-(bin|all)$/);
      if (!m) continue;
      const hashes = [];
      for (const hash of fs.readdirSync(path.join(dists, name))) {
        const dir = path.join(dists, name, hash);
        const files = fs.readdirSync(dir);
        if (files.some((f) => f.endsWith(".ok")) && files.includes(`gradle-${m[1]}`)) hashes.push(hash);
      }
      if (hashes.length) out.push({ name, version: m[1], hashes });
    }
  } catch {}
  return out;
}
function distCandidates(dist) {
  return [`https://services.gradle.org/distributions/${dist}.zip`, ...DIST_MIRRORS.map((f) => f(dist))];
}
// URL whose download is already on disk, or null (also recognises any custom mirror recorded earlier)
function cachedUrlFor(entry) {
  const known = [...distCandidates(entry.name), ...(loadConfig().gradleUrls || [])];
  return known.find((u) => entry.hashes.includes(gradleUrlHash(u))) || null;
}

// Mirrors for users in Iran (sanctions/filtering). Each is probed before a build; only the ones that answer are used.
const MAVEN_MIRRORS = [
  { url: "https://maven.myket.ir", kinds: ["google", "central"] },
  { url: "https://en-mirror.ir", kinds: ["google", "central"] },
  { url: "https://maven.aliyun.com/repository/google", kinds: ["google"] },
  { url: "https://maven.aliyun.com/repository/central", kinds: ["central"] },
  { url: "https://maven.aliyun.com/repository/gradle-plugin", kinds: ["plugin"] },
];
const PROBE = {
  google: "com/android/tools/build/gradle/8.13.0/gradle-8.13.0.pom",
  central: "org/jetbrains/kotlin/kotlin-stdlib/2.1.0/kotlin-stdlib-2.1.0.pom",
  plugin: "org/jetbrains/kotlin/jvm/org.jetbrains.kotlin.jvm.gradle.plugin/2.1.0/org.jetbrains.kotlin.jvm.gradle.plugin-2.1.0.pom",
};
const DIST_MIRRORS = [
  (d) => `https://maven.myket.ir/gradle/distributions/${d}.zip`,
  (d) => `https://mirrors.cloud.tencent.com/gradle/${d}.zip`,
  (d) => `https://mirrors.aliyun.com/gradle/distributions/v${d.replace(/^gradle-|-(bin|all)$/g, "")}/${d}.zip`,
];
async function urlOk(url, ms = 8000) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}
async function workingMirrors() {
  const results = await Promise.all(MAVEN_MIRRORS.map(async (m) => {
    const oks = await Promise.all(m.kinds.map((k) => urlOk(`${m.url}/${PROBE[k]}`)));
    return { ...m, ok: oks.some(Boolean) };
  }));
  return results;
}
function wrapperInfo() {
  const props = path.join(ANDROID, "gradle", "wrapper", "gradle-wrapper.properties");
  try {
    const m = fs.readFileSync(props, "utf8").match(/distributionUrl=.*\/(gradle-(\d+\.\d+(?:\.\d+)?)-(bin|all))\.zip/);
    return m ? { dist: m[1], version: m[2] } : null;
  } catch { return null; }
}
async function chooseDistUrl(want, useMirrors) {
  const official = (d) => `https://services.gradle.org/distributions/${d}.zip`;
  const major = vparts(want)[0];
  const cached = cachedGradles()
    .filter((c) => vparts(c.version)[0] === major && vcmp(c.version, want) >= 0)
    .sort((a, b) => (a.version === want ? -1 : b.version === want ? 1 : vcmp(b.version, a.version)));
  for (const c of cached) {
    const url = cachedUrlFor(c);
    if (url) { log(`Gradle از قبل روی سیستم هست: ${c.name} (بدون دانلود)`, "ok"); return url; }
  }
  const dist = `gradle-${want}-bin`;
  if (useMirrors) {
    for (const f of DIST_MIRRORS) {
      const u = f(dist);
      if (await urlOk(u)) { log(`Gradle ${want} یک بار از میرور دانلود می‌شود: ${new URL(u).host}`, "ok"); return u; }
      log(`میرور Gradle جواب نداد: ${new URL(u).host}`, "warn");
    }
  }
  log(`Gradle ${want} یک بار از سرور اصلی دانلود می‌شود (~130MB)`, "warn");
  return official(dist);
}
async function applyGradle(cfg, proxy) {
  const props = path.join(ANDROID, "gradle", "wrapper", "gradle-wrapper.properties");
  const info = wrapperInfo();
  // the template's version (remembered so switching to a mirror URL doesn't lose it)
  const want = info ? info.version : "8.14.3";
  const distUrl = await chooseDistUrl(want, cfg.useMirrors);
  edit(props, (s) => {
    s = s.replace(/distributionUrl=.*/, `distributionUrl=${distUrl.replace(":", "\\:")}`);
    if (/networkTimeout=\d+/.test(s)) s = s.replace(/networkTimeout=\d+/, "networkTimeout=180000");
    else s += "\nnetworkTimeout=180000\n";
    return s;
  });

  let mirrors = [];
  if (cfg.useMirrors) {
    const all = await workingMirrors();
    for (const m of all) log(`میرور ${m.url}: ${m.ok ? "✓" : "✗ (استفاده نمی‌شود)"}`, m.ok ? "out" : "warn");
    mirrors = all.filter((m) => m.ok).map((m) => m.url);
    if (!mirrors.length) log("هیچ میروری جواب نداد؛ از سرورهای اصلی استفاده می‌شود", "warn");
  }
  // Init script: put the mirrors in front of every repository list (plugins, buildscript, project deps).
  fs.mkdirSync(DATA, { recursive: true });
  const init = path.join(DATA, "gradle-mirrors.init.gradle");
  fs.writeFileSync(init, `// generated by Menchat Android Builder\ndef MIRRORS = ${JSON.stringify(mirrors)}\n` + String.raw`
def addMirrors(handler, mirrors) {
  mirrors.reverse().eachWithIndex { u, i ->
    def r = handler.maven { url = u; name = "menchatMirror" + i }
    handler.remove(r)
    handler.addFirst(r)
  }
}
beforeSettings { settings ->
  if (MIRRORS) {
    addMirrors(settings.pluginManagement.repositories, MIRRORS)
    settings.pluginManagement.repositories.gradlePluginPortal()
  }
}
allprojects { p ->
  addMirrors(p.buildscript.repositories, MIRRORS)
  addMirrors(p.repositories, MIRRORS)
}
`);

  edit(path.join(ANDROID, "gradle.properties"), (s) => {
    s = s.replace(/\r?\n?# >>> menchat-builder proxy[\s\S]*?# <<< menchat-builder proxy\r?\n?/, "\n");
    const lines = proxyProps(proxy).map(([k, v]) => `systemProp.${k}=${v}`);
    // Iranian/Chinese mirrors must be reached directly, not through a foreign proxy
    if (lines.length) lines.push("systemProp.http.nonProxyHosts=*.ir|*.aliyun.com|*.tencent.com|localhost|127.*|[::1]");
    if (lines.length) s = s.replace(/\s*$/, "\n") + `# >>> menchat-builder proxy\n${lines.join("\n")}\n# <<< menchat-builder proxy\n`;
    return s;
  });
  return init;
}

// ---------- process helpers ----------
const q = (s) => (/[\s"&()]/.test(s) ? `"${s}"` : s);
let current = null; // running child
function capture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn([cmd, ...args].map(q).join(" "), { shell: true, cwd: opts.cwd || ROOT, env: opts.env || process.env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: -1, out }));
    child.on("close", (code) => resolve({ code, out }));
  });
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const line = [cmd, ...args].map(q).join(" ");
    log(`$ ${line}`, "cmd");
    const child = spawn(line, { shell: true, cwd: opts.cwd || ROOT, env: opts.env || process.env, windowsHide: true, detached: !IS_WIN });
    current = child;
    let out = "";
    const feed = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 200000) out = out.slice(-100000);
      for (const l of s.split(/\r?\n/)) if (l.trim()) log(l);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => { current = null; reject(new Error(e.message)); });
    child.on("close", (code) => {
      current = null;
      if (job.stopRequested) return reject(new Error("متوقف شد"));
      if (code === 0) resolve(out);
      else { const e = new Error(`خطا در اجرای دستور (کد ${code})`); e.out = out; reject(e); }
    });
  });
}
function killCurrent() {
  if (!current) return;
  const pid = current.pid;
  if (IS_WIN) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else { try { process.kill(-pid, "SIGTERM"); } catch { current.kill("SIGTERM"); } }
}

// ---------- log + job state ----------
const clients = new Set();
const backlog = [];
const job = { status: "idle", step: "", action: "", startedAt: 0, finishedAt: 0, apk: "", stopRequested: false };
// When started by the exe, quit once the window has been closed (no page connected for a while).
let lastClientAt = Date.now();
if (process.env.MB_AUTOEXIT) {
  setInterval(() => {
    if (clients.size > 0) { lastClientAt = Date.now(); return; }
    if (Date.now() - lastClientAt > 3000) {
      if (job.status === "running") { job.stopRequested = true; killCurrent(); }
      process.exit(0);
    }
  }, 1000);
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
function log(text, kind = "out") {
  const entry = { t: Date.now(), text, kind };
  backlog.push(entry);
  if (backlog.length > 4000) backlog.splice(0, backlog.length - 4000);
  try { fs.appendFileSync(LOG_FILE, text + "\n"); } catch {}
  broadcast("log", entry);
}
function setJob(patch) { Object.assign(job, patch); broadcast("job", job); }

// ---------- native project edits ----------
function edit(file, fn) {
  if (!exists(file)) { log(`(پیدا نشد: ${path.relative(ROOT, file)})`, "warn"); return; }
  const before = fs.readFileSync(file, "utf8");
  const after = fn(before);
  if (after !== before) fs.writeFileSync(file, after);
}
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'").replace(/"/g, '\\"');

function applyWebConfig(cfg) {
  const jsonFile = path.join(ROOT, "capacitor.config.json");
  if (exists(jsonFile)) {
    edit(jsonFile, (s) => {
      const json = JSON.parse(s.replace(/^\uFEFF/, ""));
      json.appId = cfg.appId;
      json.appName = cfg.appName;
      return JSON.stringify(json, null, 2) + "\n";
    });
  }
  for (const name of ["capacitor.config.ts", "capacitor.config.js"]) {
    const tsFile = path.join(ROOT, name);
    if (exists(tsFile)) {
      edit(tsFile, (s) => s
        .replace(/appId\s*:\s*["'`]([^"'`]+)["'`]/, `appId: '${cfg.appId}'`)
        .replace(/appName\s*:\s*["'`]([^"'`]+)["'`]/, `appName: '${cfg.appName}'`));
    }
  }
  if (cfg.serverUrl !== undefined) {
    const envFile = path.join(ROOT, ".env.android");
    let s = exists(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    if (/^VITE_NAKAMA_HTTP_URL=.*$/m.test(s)) s = s.replace(/^VITE_NAKAMA_HTTP_URL=.*$/m, `VITE_NAKAMA_HTTP_URL=${cfg.serverUrl}`);
    else s = `VITE_NAKAMA_HTTP_URL=${cfg.serverUrl}\n` + s;
    fs.writeFileSync(envFile, s);
  }
  if (cfg.updateServerUrl !== undefined) {
    const envFile = path.join(ROOT, ".env.android");
    let s = exists(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    if (/^VITE_UPDATE_SERVER_URL=.*$/m.test(s)) s = s.replace(/^VITE_UPDATE_SERVER_URL=.*$/m, `VITE_UPDATE_SERVER_URL=${cfg.updateServerUrl}`);
    else s = `VITE_UPDATE_SERVER_URL=${cfg.updateServerUrl}\n` + s;
    fs.writeFileSync(envFile, s);
  }
  // test → Custom Connect menu on the connecting screen; release → straight to the main server.
  const envFile = path.join(ROOT, ".env.android");
  const buildType = cfg.buildType === "release" ? "release" : "test";
  const directApk = cfg.directApkDownload ? "true" : "false";
  let env = exists(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  if (/^VITE_BUILD_TYPE=.*$/m.test(env)) env = env.replace(/^VITE_BUILD_TYPE=.*$/m, `VITE_BUILD_TYPE=${buildType}`);
  else env = env.replace(/\n?$/, "\n") + `VITE_BUILD_TYPE=${buildType}\n`;
  if (/^VITE_DIRECT_APK_DOWNLOAD=.*$/m.test(env)) env = env.replace(/^VITE_DIRECT_APK_DOWNLOAD=.*$/m, `VITE_DIRECT_APK_DOWNLOAD=${directApk}`);
  else env = env.replace(/\n?$/, "\n") + `VITE_DIRECT_APK_DOWNLOAD=${directApk}\n`;
  fs.writeFileSync(envFile, env);
}

function applyNative(cfg, sdk) {
  const app = path.join(ANDROID, "app");
  const res = path.join(app, "src", "main", "res");
  edit(path.join(app, "build.gradle"), (s) => s
    .replace(/applicationId\s+["'][^"']*["']/, `applicationId "${nativeAppId(cfg)}"`)
    .replace(/versionCode\s+\d+/, `versionCode ${cfg.versionCode}`)
    .replace(/versionName\s+["'][^"']*["']/, `versionName "${cfg.versionName}"`));
  edit(path.join(res, "values", "strings.xml"), (s) => s
    .replace(/(<string name="app_name">)[\s\S]*?(<\/string>)/, `$1${xmlEscape(nativeAppName(cfg))}$2`)
    .replace(/(<string name="title_activity_main">)[\s\S]*?(<\/string>)/, `$1${xmlEscape(nativeAppName(cfg))}$2`)
    .replace(/(<string name="package_name">)[\s\S]*?(<\/string>)/, `$1${nativeAppId(cfg)}$2`)
    .replace(/(<string name="custom_url_scheme">)[\s\S]*?(<\/string>)/, `$1${nativeAppId(cfg)}$2`));
  edit(path.join(app, "src", "main", "AndroidManifest.xml"), (s) => {
    let t = s.replace(/<activity\b[^>]*?\.MainActivity[^>]*>/, (tag) => {
      let act = tag.replace(/\s+android:screenOrientation="[^"]*"/, "");
      if (cfg.orientation && cfg.orientation !== "unspecified") act = act.replace(/^<activity/, `<activity\n            android:screenOrientation="${cfg.orientation}"`);
      return act;
    });
    const permTag = '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />';
    if (cfg.directApkDownload) {
      if (!t.includes("android.permission.REQUEST_INSTALL_PACKAGES")) {
        t = t.replace(/<\/manifest>/, `    ${permTag}\n</manifest>`);
      }
    } else {
      t = t.replace(/\s*<!--[\s\S]*?-->\s*<uses-permission android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"\s*\/>/g, "");
      t = t.replace(/\s*<uses-permission android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"\s*\/>/g, "");
    }
    return t;
  });
  writeStoreKeys(cfg);
  if (sdk) fs.writeFileSync(path.join(ANDROID, "local.properties"), `sdk.dir=${sdk.path.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`);

  const generated = path.join(ICON_DIR, "res");
  if (exists(generated)) {
    let n = 0;
    for (const dir of fs.readdirSync(generated)) {
      for (const f of fs.readdirSync(path.join(generated, dir))) {
        fs.mkdirSync(path.join(res, dir), { recursive: true });
        fs.copyFileSync(path.join(generated, dir, f), path.join(res, dir, f));
        n++;
      }
    }
    const bg = path.join(res, "values", "ic_launcher_background.xml");
    fs.mkdirSync(path.dirname(bg), { recursive: true });
    fs.writeFileSync(bg, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${cfg.iconBackground}</color>\n</resources>\n`);
    const anydpi = path.join(res, "mipmap-anydpi-v26");
    fs.mkdirSync(anydpi, { recursive: true });
    const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n`;
    fs.writeFileSync(path.join(anydpi, "ic_launcher.xml"), adaptive);
    fs.writeFileSync(path.join(anydpi, "ic_launcher_round.xml"), adaptive);
    log(`آیکون اعمال شد (${n} فایل)`, "ok");
  }
  log(`اسم: ${nativeAppName(cfg)} · شناسه: ${nativeAppId(cfg)} · نسخه: ${cfg.versionName} (${cfg.versionCode}) · جهت: ${cfg.orientation} · نوع بیلد: ${cfg.buildType === "release" ? "اصلی" : "تست"} · استور: ${storeNames(cfg.stores)}`, "ok");
}

// ---------- devices ----------
async function listDevices(cfg) {
  const sdk = detectSdk(cfg);
  const adb = adbPath(sdk);
  if (!adb) return { adb: null, devices: [] };
  const { out } = await capture(adb, ["devices", "-l"]);
  const devices = out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("*")).map((l) => {
    const [serial, state] = l.split(/\s+/);
    const model = (l.match(/model:(\S+)/) || [])[1] || "";
    return { serial, state, model: model.replace(/_/g, " ") };
  });
  return { adb, devices };
}

// ---------- the build job ----------
async function runJob(action) {
  if (job.status === "running") throw new Error("یک بیلد در حال اجراست");
  const cfg = loadConfig();
  // Players only ever get release builds: the publish actions build as
  // release whatever «نوع بیلد» says, and put that setting back afterwards.
  const publishing = action.startsWith("publish-");
  const userBuildType = cfg.buildType;
  if (publishing) cfg.buildType = "release";
  backlog.length = 0;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  try { fs.writeFileSync(LOG_FILE, ""); } catch {}
  setJob({ status: "running", action, step: "", startedAt: Date.now(), finishedAt: 0, stopRequested: false });
  broadcast("clear", {});
  const step = (name) => { setJob({ step: name }); log(`▸ ${name}`, "step"); };
  const oldVersion = appVersion();
  let bumped = false;
  const bump = (part) => {
    const v = nextVersion(part, oldVersion);
    setAppVersion(v);
    bumped = true;
    cfg.versionName = v;
    broadcast("config", loadConfig());
    log(`نسخه: ${oldVersion} → ${v}`, "ok");
  };
  try {
    const jdk = detectJdk(cfg);
    const sdk = detectSdk(cfg);
    const adb = adbPath(sdk);
    const env = toolEnv(jdk, sdk);
    let apk = "";
    const configuredUpdateServer = (cfg.updateServerUrl || cfg.serverUrl || "").replace(/\/$/, "");
    const primaryUploadServer = (cfg.publishTargetServer ? cfg.publishTargetServer.trim() : "").replace(/\/$/, "") || configuredUpdateServer;
    const isDual = !!cfg.dualPublish && !!primaryUploadServer && !!configuredUpdateServer && primaryUploadServer !== configuredUpdateServer;

    if (publishing) {
      if (!readPublishKey()) throw new Error("کلید انتشار وارد نشده. در بخش «انتشار برای بازیکن‌ها» همان APP_UPDATE_PUBLISH_KEY سرور را وارد کن.");
      if (!/^https?:\/\//.test(primaryUploadServer)) throw new Error("آدرس سرور مقصد آپلود نامعتبر یا خالی است.");
      log("نوع بیلد برای انتشار: اصلی (release)");
      log(`آدرس سرور آپدیت کامپایل‌شده در اپ: ${configuredUpdateServer || "(خالی)"}`);
      log(`سرور مقصد آپلود: ${primaryUploadServer}`);
      if (isDual) {
        log(`انتشار همزمان (Dual-Publish) فعال است: فایل‌ها روی سرور دوم (${configuredUpdateServer}) نیز آپلود خواهند شد.`);
      }
    }

    // The last APK built here, published as it is (its version is not changed).
    if (action === "publish-apk") {
      step("بررسی APK");
      apk = cfg.lastApk ? path.join(ARTIFACTS, cfg.lastApk) : "";
      if (!apk || !exists(apk)) throw new Error("هنوز APK‌ای با بیلدر ساخته نشده؛ اول با «کلید خودمان» بیلد بگیر.");
      log(`APK: artifacts\\${cfg.lastApk} (${(fs.statSync(apk).size / 1048576).toFixed(1)} MB)`);
      const sig = readSigning();
      if (!sig) throw new Error("کلید امضا در بیلدر ثبت نشده، پس نمی‌شود مطمئن شد این APK با کلید بازار امضا شده. اول در «کلید امضا» کلید را ثبت کن.");
      const cert = await apkCertSha256(jdk, sdk, apk);
      if (!cert) log("هشدار: امضای APK بررسی نشد (apksigner در Android SDK پیدا نشد).", "warn");
      else if (cert !== sig.sha256.replace(/:/g, "").toLowerCase()) {
        throw new Error("این APK با کلید امضای ثبت‌شده امضا نشده (احتمالاً با کلید تست). «امضای APK» را روی «کلید خودمان» بگذار و دوباره بیلد بگیر.");
      } else log(`امضا: کلید خودمان ✓ (${sig.alias})`, "ok");
      step(`انتشار APK روی سرور ${primaryUploadServer}`);
      await runPublish("publish-apk.mjs", ["--apk", apk, "--server", primaryUploadServer], env);
      if (isDual) {
        step(`انتشار نسخه دوم APK روی سرور ${configuredUpdateServer}`);
        await runPublish("publish-apk.mjs", ["--apk", apk, "--server", configuredUpdateServer], env);
      }
      log("APK منتشر شد. بازیکن‌های نسخه‌های قبلی (x کمتر) باید آن را نصب کنند.", "ok");
      setJob({ status: "ok", step: "", finishedAt: Date.now() });
      return;
    }

    // y / z: live update (web code only), no APK.
    if (action === "publish-z" || action === "publish-y") {
      const npm = IS_WIN ? "npm.cmd" : "npm";
      step("اعمال تنظیمات وب");
      applyWebConfig(cfg);
      if (needsInstall()) { step("نصب پکیج‌ها (npm install)"); await run(npm, ["install"], { env }); }
      bump(action.slice(-1));
      step(`بیلد و انتشار آپدیت داخلی روی ${primaryUploadServer}`);
      await runPublish("publish-update.mjs", ["--server", primaryUploadServer], env);
      if (isDual) {
        step(`انتشار نسخه دوم روی ${configuredUpdateServer} بدون بیلد مجدد`);
        await runPublish("publish-update.mjs", ["--skip-build", "--server", configuredUpdateServer], env);
      }
      log(`آپدیت ${cfg.versionName} منتشر شد. بازیکن‌ها دفعه‌ی بعد که بازی را باز کنند پاپ‌آپ را می‌بینند.`, "ok");
      setJob({ status: "ok", step: "", finishedAt: Date.now() });
      return;
    }

    if (action !== "install") {
      step("بررسی ابزارها");
      if (!jdk) throw new Error("JDK پیدا نشد. JDK 21 نصب کن یا مسیرش را در «تنظیمات پیشرفته» بده.");
      if (jdk.version && jdk.version < 21) throw new Error(`JDK ${jdk.version} پیدا شد ولی Capacitor 8 به JDK 21 یا بالاتر نیاز دارد.`);
      if (!sdk) throw new Error("Android SDK پیدا نشد. Android Studio را نصب کن یا مسیر SDK را در «تنظیمات پیشرفته» بده.");
      log(`JDK ${jdk.version || "?"}: ${jdk.path}`);
      log(`SDK: ${sdk.path} · platforms: ${sdk.platforms.join(", ") || "-"}`);

      if (action === "publish-x" && cfg.stores.length > 1) {
        throw new Error("برای «انتشار APK جدید (x)» فقط یک استور را تیک بزن؛ سرور یک APK برای دانلود نگه می‌دارد. APK استور دیگر را جدا بیلد بگیر و در همان استور منتشر کن.");
      }
      if (cfg.stores.includes("myket") && !cleanKey(cfg.myketRsaKey)) {
        log("هشدار: کلید RSA مایکت خالی است؛ در APK مایکت خرید کار نمی‌کند.", "warn");
      }
      const release = cfg.signWith === "release";
      if (action === "publish-x" && !release) {
        throw new Error("APK برای بازیکن‌ها باید با «کلید خودمان» امضا شود؛ APK با کلید تست روی نسخه‌ی بازار نصب نمی‌شود. در بخش «کلید امضا» امضا را روی «کلید خودمان» بگذار.");
      }
      if (release) {
        writeKeystoreProps();
        const sig = readSigning();
        log(`امضا: کلید خودمان (${sig.fileName} · ${sig.alias} · SHA-256 ${sig.sha256.slice(0, 23)}…)`);
      } else log("امضا: کلید تست (debug). روی نسخه‌ای که از بازار نصب شده نصب نمی‌شود.");
      if (action === "publish-x") bump("x");

      if (cfg.autoIncrement && cfg.versionCode <= (cfg.lastBuiltCode || 0)) {
        cfg.versionCode = cfg.lastBuiltCode + 1;
        saveConfig(cfg);
        broadcast("config", loadConfig());
        log(`versionCode خودکار → ${cfg.versionCode}`);
      }
      step("اعمال تنظیمات وب");
      applyWebConfig(cfg);

      const npm = IS_WIN ? "npm.cmd" : "npm";
      const npx = IS_WIN ? "npx.cmd" : "npx";
      if (needsInstall()) { step("نصب پکیج‌ها (npm install)"); await run(npm, ["install"], { env }); }

      if (!exists(path.join(ANDROID, IS_WIN ? "gradlew.bat" : "gradlew"))) {
        step("بیلد وب");
        await run(npm, ["run", "build", "--", "--mode", "android"], { env });
      // Web build hash from dist/bundle.json (changes with every web code change).
      const webKey = String(readJson(path.join(ROOT, "dist", "bundle.json"), {}).build || "");
      // The first store's APK is the one installed on the phone / published.
      apk = path.join(ARTIFACTS, apkName(cfg, cfg.stores[0], key, webKey));
        step("ساخت پروژه اندروید (cap add)");
        await run(npx, ["cap", "add", "android"], { env });
      }
      // Native edits come before the web build: the build's version stamp
      // (dist/bundle.json) hashes the native code, including the manifest.
      step("اعمال اسم، نسخه، آیکون");
      applyNative(cfg, sdk);

      const key = await nativeKey().catch(() => "");
      const sameMajor = (a, b) => String(a || "").split(".")[0] === String(b || "").split(".")[0];
      if (!publishing && key && cfg.lastNativeKey && key !== cfg.lastNativeKey && sameMajor(appVersion(), cfg.lastBuiltVersion)) {
        log("هشدار: کد اندرویدی (پلاگین‌ها، جاوا، Manifest یا capacitor.config) از بیلد قبلی عوض شده ولی x بالا نرفته. اگر این APK به بازیکن‌ها می‌رسد، از دکمه‌ی «ساخت و انتشار APK جدید (x)» استفاده کن؛ وگرنه آپدیت‌های داخلی به آن نمی‌رسد.", "warn");
      }

      step("بیلد وب");
      await run(npm, ["run", "build", "--", "--mode", "android"], { env });

      step("همگام‌سازی (cap sync)");
      await run(npx, ["cap", "sync", "android"], { env });

      step("بیلد APK (Gradle)");
      const proxy = await resolveProxy(cfg);
      if (proxy) log(`پروکسی: ${proxy.type} ${proxy.host}:${proxy.port}${proxy.auto ? " (تشخیص خودکار)" : ""}${proxy.up ? "" : " — در دسترس نیست!"}`, proxy.up ? "out" : "warn");
      else log("بدون پروکسی");
      const initScript = await applyGradle(cfg, proxy);
      const genv = env;
      if (!IS_WIN) { try { fs.chmodSync(path.join(ANDROID, "gradlew"), 0o755); } catch {} }
      try {
        const tasks = cfg.stores.map((st) => `assemble${STORES[st].gradle}${release ? "Release" : "Debug"}`);
        await run(path.join(ANDROID, IS_WIN ? "gradlew.bat" : "gradlew"), [...tasks, "--console=plain", "--init-script", initScript], { cwd: ANDROID, env: genv });
      } catch (e) {
        if (/timeout|timed out|Could not (resolve|GET|HEAD|download)|UnknownHost|Connection (refused|reset)|Downloading from/i.test(e.out || "")) {
          throw new Error("دانلود Gradle/کتابخانه‌ها ناموفق بود. در بخش «شبکه» میرورها را روشن نگه دار و «بررسی» را بزن؛ اگر میروری جواب نداد، v2rayN را وصل کن و پروکسی را روی «خودکار» بگذار.");
        }
        throw e;
      }
      for (const st of cfg.stores) {
        const kind = release ? "release" : "debug";
        const built = path.join(ANDROID, "app", "build", "outputs", "apk", st, kind, `app-${st}-${kind}.apk`);
        if (!exists(built)) throw new Error(`فایل APK ${STORES[st].name} ساخته نشد`);
        const out = path.join(ARTIFACTS, apkName(cfg, st, key, webKey));
        fs.copyFileSync(built, out);
        fs.copyFileSync(built, path.join(ARTIFACTS, `${getAppSlug(cfg)}-${st}-${kind}.apk`));
        log(`APK ${STORES[st].name} آماده شد: artifacts\\${path.basename(out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`, "ok");
      }
      cfg.lastBuiltCode = cfg.versionCode;
      cfg.lastApk = path.basename(apk);
      cfg.lastNativeKey = key;
      cfg.lastBuiltVersion = appVersion();
      saveConfig(cfg);
      broadcast("config", loadConfig());
      if (cfg.stores.length > 1) log(`روی گوشی APK ${STORES[cfg.stores[0]].name} نصب می‌شود.`);
      setJob({ apk: path.basename(apk) });

      if (action === "publish-x") {
        step("انتشار APK روی سرور");
        await runPublish("publish-apk.mjs", ["--apk", apk], env);
        log(`APK ${cfg.versionName} منتشر شد. بازیکن‌های نسخه‌های قبلی باید آن را نصب کنند.`, "ok");
      }
    } else {
      apk = cfg.lastApk && exists(path.join(ARTIFACTS, cfg.lastApk)) ? path.join(ARTIFACTS, cfg.lastApk) : path.join(ARTIFACTS, `${getAppSlug(cfg)}-${cfg.stores[0]}-debug.apk`);
      if (!exists(apk)) throw new Error("هنوز APK ای ساخته نشده؛ اول بیلد بگیر.");
    }

    if (action === "build-run" || action === "install") {
      step("نصب روی گوشی");
      if (!adb) throw new Error("adb پیدا نشد (platform-tools در SDK نصب نیست).");
      const { devices } = await listDevices(cfg);
      const ready = devices.filter((d) => d.state === "device");
      const unauthorized = devices.find((d) => d.state === "unauthorized");
      let target = ready.find((d) => d.serial === cfg.device) || ready[0];
      if (!target) {
        throw new Error(unauthorized
          ? "گوشی وصله ولی اجازه‌ی USB debugging تأیید نشده. روی صفحه‌ی گوشی «Allow» را بزن و دوباره امتحان کن."
          : "گوشی‌ای پیدا نشد. USB debugging را روشن کن و کابل را چک کن.");
      }
      log(`دستگاه: ${target.model || target.serial}`);
      try {
        await run(adb, ["-s", target.serial, "install", "-r", "-d", apk], { env });
      } catch (e) {
        if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(e.out || "")) {
          throw new Error(cfg.signWith === "release"
            ? "نسخه‌ای از این برنامه با امضای دیگری روی گوشی نصب است (کلید ثبت‌شده با آن یکی نیست). با دکمه‌ی «حذف از گوشی» پاکش کن یا کلید درست را ثبت کن."
            : "نسخه‌ای از این برنامه با امضای دیگری روی گوشی نصب است (مثلاً نسخه‌ی بازار). در بخش «کلید امضا» امضا را روی «کلید خودمان» بگذار، یا با «حذف از گوشی» پاکش کن.");
        }
        throw e;
      }
      step("اجرای برنامه");
      await run(adb, ["-s", target.serial, "shell", "monkey", "-p", nativeAppId(cfg), "-c", "android.intent.category.LAUNCHER", "1"], { env });
      log("برنامه روی گوشی اجرا شد ✓", "ok");
    }
    setJob({ status: "ok", step: "", finishedAt: Date.now() });
  } catch (e) {
    log(e.message, "error");
    if (bumped) {
      // Nothing was published: keep the old version so a retry does not skip one.
      setAppVersion(oldVersion);
      broadcast("config", loadConfig());
      log(`نسخه به ${oldVersion} برگشت`, "warn");
    }
    setJob({ status: job.stopRequested ? "stopped" : "failed", finishedAt: Date.now() });
  } finally {
    if (publishing && userBuildType !== "release") {
      const c = loadConfig();
      c.buildType = userBuildType;
      saveConfig(c);
      applyWebConfig(c);
      broadcast("config", loadConfig());
    }
  }
}

/**
 * Runs a publish script. Once it printed "✔ Published" the server has the
 * release, so a later failure (Node can crash on exit on Windows) still
 * counts as success and the version is not rolled back.
 */
async function runPublish(script, args, env) {
  const scriptPath = [
    path.join(ROOT, "scripts", script),
    path.join(PKG_ROOT, "scripts", script),
  ].find(fs.existsSync);
  if (!scriptPath) throw new Error(`اسکریپت انتشار ${script} پیدا نشد.`);
  try {
    await run(process.execPath, [scriptPath, ...args], { env });
  } catch (e) {
    if (!/✔ Published/.test(e.out || "")) throw e;
    log("انتشار روی سرور انجام شد؛ خطای بعد از آن (موقع بسته شدن Node) مهم نیست.", "warn");
  }
}

/** npm install is needed when packages are missing or package.json changed. */
function needsInstall() {
  const stamp = path.join(ROOT, "node_modules", ".package-lock.json");
  if (!exists(path.join(ROOT, "node_modules", "@capacitor", "android")) || !exists(stamp)) return true;
  const deps = (p) => JSON.stringify((({ dependencies, devDependencies }) => ({ dependencies, devDependencies }))(readJson(p, {})));
  // Only dependency changes count; a version bump in package.json does not.
  const lock = readJson(path.join(ROOT, "package-lock.json"), {});
  const root = lock.packages?.[""] || {};
  return deps(PACKAGE_FILE) !== JSON.stringify({ dependencies: root.dependencies, devDependencies: root.devDependencies });
}

async function uninstall() {
  const cfg = loadConfig();
  const { adb, devices } = await listDevices(cfg);
  const target = devices.filter((d) => d.state === "device").find((d) => d.serial === cfg.device) || devices.find((d) => d.state === "device");
  if (!adb || !target) throw new Error("گوشی‌ای پیدا نشد");
  const r = await capture(adb, ["-s", target.serial, "uninstall", nativeAppId(cfg)]);
  log(`حذف ${nativeAppId(cfg)} از ${target.model || target.serial}: ${r.out.trim()}`, r.code === 0 ? "ok" : "warn");
}

// ---------- http ----------
function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const ALLOWED = ["useMirrors", "appName", "appId", "versionCode", "autoIncrement", "orientation", "serverUrl", "updateServerUrl", "publishTargetServer", "dualPublish", "buildType", "iconBackground", "iconScale", "device", "proxyMode", "proxyAddress", "jdkPath", "sdkPath", "stores", "signWith", "bazaarRsaKey", "myketRsaKey"];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, fs.readFileSync(path.join(UI, "index.html")), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/favicon.png") { const p = getFaviconPath(); return p ? send(res, 200, fs.readFileSync(p), "image/png") : send(res, 404, ""); }
    if (req.method === "GET" && url.pathname === "/font.woff2") { const p = getFontPath(); return p ? send(res, 200, fs.readFileSync(p), "font/woff2") : send(res, 404, ""); }
    if (req.method === "GET" && url.pathname === "/icon.png") {
      const p = path.join(ICON_DIR, "source.png");
      return exists(p) ? send(res, 200, fs.readFileSync(p), "image/png") : send(res, 404, "");
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const cfg = loadConfig();
      const jdk = detectJdk(cfg);
      const sdk = detectSdk(cfg);
      return send(res, 200, { version: VERSION, config: cfg, job, jdk, sdk: sdk && { path: sdk.path, platforms: sdk.platforms }, adb: adbPath(sdk), hasAndroid: exists(path.join(ANDROID, "app")), root: ROOT });
    }
    if (req.method === "GET" && url.pathname === "/api/proxy") {
      const [proxy, mirrors] = await Promise.all([resolveProxy(loadConfig()), workingMirrors()]);
      return send(res, 200, { proxy, gradles: cachedGradles(), mirrors });
    }
    if (req.method === "POST" && url.pathname === "/api/quit") {
      send(res, 200, { ok: true });
      if (job.status === "running") { job.stopRequested = true; killCurrent(); }
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/devices") return send(res, 200, await listDevices(loadConfig()));
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
      for (const e of backlog) res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      req.on("close", () => { clients.delete(res); lastClientAt = Date.now(); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readBody(req);
      const cfg = loadConfig();
      for (const k of ALLOWED) if (k in (body.config || {})) cfg[k] = body.config[k];
      cfg.versionCode = Math.max(1, parseInt(cfg.versionCode, 10) || 1);
      const wantVersion = String(body.config?.versionName ?? "").trim();
      if (wantVersion && wantVersion !== appVersion()) {
        if (job.status === "running") return send(res, 409, { error: "یک بیلد در حال اجراست" });
        if (!VERSION_RE.test(wantVersion)) return send(res, 400, { error: "نسخه باید به شکل x.y.z باشد (مثل 1.2.3)" });
        setAppVersion(wantVersion);
      }
      if (typeof body.publishKey === "string" && body.publishKey.trim()) {
        if (/[\s"']/.test(body.publishKey.trim())) return send(res, 400, { error: "کلید انتشار نباید فاصله یا کوتیشن داشته باشد" });
        writePublishKey(body.publishKey.trim());
      }
      cfg.stores = normalizeStores(cfg.stores);
      for (const k of ["bazaarRsaKey", "myketRsaKey"]) {
        cfg[k] = cleanKey(cfg[k]);
        if (cfg[k] && !/^[A-Za-z0-9+/=]+$/.test(cfg[k])) return send(res, 400, { error: "کلید RSA باید متن base64 باشد (همان که در پنل استور است)" });
      }
      cfg.iconScale = Math.min(150, Math.max(40, Number(cfg.iconScale) || 100));
      if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(cfg.appId)) return send(res, 400, { error: "شناسه‌ی برنامه نامعتبر است (مثل com.menchat.react)" });
      if (!/^#[0-9a-fA-F]{6}$/.test(cfg.iconBackground)) cfg.iconBackground = "#073773";
      if (body.icons) {
        fs.rmSync(path.join(ICON_DIR, "res"), { recursive: true, force: true });
        for (const [rel, b64] of Object.entries(body.icons)) {
          if (!/^mipmap-[a-z]+\/ic_launcher(_round|_foreground)?\.png$/.test(rel)) continue;
          const out = path.join(ICON_DIR, "res", rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, Buffer.from(b64, "base64"));
        }
      }
      if (body.source) { fs.mkdirSync(ICON_DIR, { recursive: true }); fs.writeFileSync(path.join(ICON_DIR, "source.png"), Buffer.from(body.source, "base64")); }
      saveConfig(cfg);
      return send(res, 200, { config: loadConfig() });
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const { action } = await readBody(req);
      if (!["build", "build-run", "install", "publish-z", "publish-y", "publish-x", "publish-apk"].includes(action)) return send(res, 400, { error: "bad action" });
      if (job.status === "running") return send(res, 409, { error: "یک بیلد در حال اجراست" });
      runJob(action);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      if (job.status === "running") { job.stopRequested = true; killCurrent(); log("درخواست توقف…", "warn"); }
      return send(res, 200, { ok: true });
    }
    // Releases on the update server (list / delete / publish). The publish key stays here.
    if ((req.method === "GET" && url.pathname === "/api/releases") || (req.method === "POST" && (url.pathname === "/api/releases/delete" || url.pathname === "/api/releases/publish"))) {
      const cfg = loadConfig();
      const key = readPublishKey();
      if (!key) return send(res, 400, { error: "کلید انتشار وارد نشده. در بخش «انتشار برای بازیکن‌ها» واردش کن." });
      const targetServer = (cfg.publishTargetServer || cfg.updateServerUrl || cfg.serverUrl || "").replace(/\/$/, "");
      if (!/^https?:\/\//.test(targetServer)) return send(res, 400, { error: "آدرس سرور آپدیت خالی است." });
      const base = targetServer;
      const isPost = req.method === "POST";
      const isPublish = url.pathname === "/api/releases/publish";
      const body = isPost ? await readBody(req) : null;
      try {
        const endpoint = !isPost ? "/app-update/admin/releases" : isPublish ? "/app-update/admin/publish" : "/app-update/admin/delete";
        const r = await fetch(base + endpoint, {
          method: isPost ? "POST" : "GET",
          headers: { "X-Publish-Key": key, "X-App-Id": cfg.appId || "", "Content-Type": "application/json" },
          body: isPost ? JSON.stringify(isPublish ? { kind: body.kind, version: body.version, published: !!body.published } : { kind: body.kind, version: body.version }) : undefined,
          signal: AbortSignal.timeout(20000),
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 401) return send(res, 400, { error: "سرور کلید انتشار را قبول نکرد." });
        if (r.status === 404 && !data.error) return send(res, 400, { error: "سرور هنوز مدیریت نسخه ندارد؛ اول کد جدید سرور را دیپلوی کن." });
        if (!r.ok) return send(res, 400, { error: data.error || `خطای سرور (${r.status})` });
        if (url.pathname === "/api/releases/delete") log(`از سرور حذف شد: ${body.kind === "apk" ? "APK" : "آپدیت داخلی"} ${body.version}`, "warn");
        if (isPublish) log(`وضعیت انتشار تغییر کرد: ${body.kind === "apk" ? "APK" : "آپدیت داخلی"} ${body.version} ← ${body.published ? "منتشر شده" : "پیش‌نویس (غیرفعال)"}`, body.published ? "ok" : "warn");
        return send(res, 200, { ...data, server: base, localNativeKey: await nativeKey().catch(() => "") });
      } catch (e) {
        return send(res, 400, { error: `سرور ${base} در دسترس نیست (${e.message}).` });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/signing") {
      if (job.status === "running") return send(res, 409, { error: "یک بیلد در حال اجراست" });
      const body = await readBody(req);
      try {
        const signing = await saveSigning({
          file: body.file ? Buffer.from(body.file, "base64") : null,
          fileName: path.basename(String(body.fileName || "").replace(/\\/g, "/")).slice(0, 120),
          alias: body.alias, storePassword: body.storePassword, keyPassword: body.keyPassword,
        });
        log(`کلید امضا ثبت شد: ${signing.fileName} · ${signing.alias} · SHA-256 ${signing.sha256}`, "ok");
        return send(res, 200, { signing });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/signing/aliases") {
      const body = await readBody(req);
      if (!body.file) return send(res, 400, { error: "فایل keystore را انتخاب کن." });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-alias-"));
      try {
        const file = path.join(tmp, "check.keystore");
        fs.writeFileSync(file, Buffer.from(body.file, "base64"));
        return send(res, 200, { aliases: await listAliases(file) });
      } catch (e) { return send(res, 400, { error: e.message }); }
      finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    if (req.method === "POST" && url.pathname === "/api/signing/clear") {
      if (job.status === "running") return send(res, 409, { error: "یک بیلد در حال اجراست" });
      clearSigning();
      const cfg = loadConfig(); cfg.signWith = "debug"; saveConfig(cfg);
      return send(res, 200, { signing: signingStatus() });
    }
    if (req.method === "POST" && url.pathname === "/api/uninstall") {
      if (job.status === "running") return send(res, 409, { error: "یک بیلد در حال اجراست" });
      await uninstall();
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/open-artifacts") {
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      if (IS_WIN) spawn("explorer", [ARTIFACTS], { detached: true, windowsHide: false });
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (IS_WIN) process.on("SIGINT", () => { killCurrent(); process.exit(0); });
function listen(port, tries = 10) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && tries > 0) listen(port + 1, tries - 1);
    else { console.error(e); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Menchat Android Builder: ${url}\n  (keep this window open while using the builder)\n`);
    if (IS_WIN && !process.env.MB_UI && !process.argv.includes("--no-open")) spawn("cmd", ["/c", "start", "", url], { detached: true, windowsHide: true });
  });
}
const portArgIdx = process.argv.indexOf("--port");
const argPort = portArgIdx !== -1 && process.argv[portArgIdx + 1] ? Number(process.argv[portArgIdx + 1]) : null;
listen(argPort || Number(process.env.PORT) || 5179);
