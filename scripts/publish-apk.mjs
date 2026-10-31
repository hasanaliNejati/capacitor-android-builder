// Publish a new APK. Use this when x of the version goes up (native code
// changed: Capacitor plugins or Java). Every player on an older x, or on other
// native code, must install it: the popup downloads it from our server or
// opens its store's page (APP_UPDATE_STORE_URL_BAZAAR / _MYKET on the server).
//
//   npm run publish-apk -- --apk artifacts/menchat-2.0.0-7.apk
//   npm run publish-apk                    newest .apk in artifacts/
//   npm run publish-apk -- --test          a test APK (test servers only)
//
// The APK must be built from the current code: its version and native key
// (assets/public/bundle.json) are read from the APK and checked.
// See update-server.mjs for the server address and publish key.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { computeNativeKey } from "./bundle-info.mjs";
import { ROOT, arg, connect, fail, sha256 } from "./update-server.mjs";

/** Reads one file from a zip (an APK) without extra tools. */
function readZipEntry(zip, name) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function newestApk() {
  const dir = path.join(ROOT, "artifacts");
  const apks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".apk")) : [];
  apks.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return apks.length ? path.join(dir, apks[0]) : null;
}

async function main() {
  const apkPath = arg("--apk") ? path.resolve(arg("--apk")) : newestApk();
  if (!apkPath || !fs.existsSync(apkPath)) fail("APK not found. Pass --apk path/to/app.apk.");
  const apk = fs.readFileSync(apkPath);
  const stamp = readZipEntry(apk, "assets/public/bundle.json");
  if (!stamp) fail(`${path.basename(apkPath)} has no version stamp (assets/public/bundle.json). Rebuild it with the current code.`);
  const { version, nativeKey, buildType } = JSON.parse(stamp.toString("utf8"));
  const wantType = process.argv.includes("--test") ? "test" : "release";
  if (!buildType) fail(`${path.basename(apkPath)} was built before build types were stamped; rebuild it with the current code.`);
  if (buildType !== wantType) {
    fail(buildType === "test"
      ? `${path.basename(apkPath)} is a TEST build. Build the APK with build type «اصلی» (release), or pass --test to publish it to a test server.`
      : `${path.basename(apkPath)} is a release build but --test was given.`);
  }
  if (nativeKey !== computeNativeKey()) {
    console.warn("! The APK's native key differs from the current source. Make sure this is the APK you want to ship.");
  }

  const { server, uploadMissing, publish } = connect();
  const hash = sha256(apk);
  console.log(`APK ${path.basename(apkPath)} · version ${version} · ${buildType} · native ${nativeKey} · ${(apk.length / 1048576).toFixed(1)} MB · server ${server}`);
  await uploadMissing([{ name: path.basename(apkPath), hash, size: apk.length, read: () => apk }]);
  await publish("/app-update/publish/apk", { version, nativeKey, buildType, hash });
  console.log(`\n✔ Published APK ${version}. Players on older versions must install it before playing.`);
}

main().catch((error) => fail(error.stack || String(error)));
