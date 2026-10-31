// Publish a live update (no APK) of the Android app. The version comes from
// package.json "version" (x.y.z):
//   raise z -> players see an optional update popup
//   raise y -> players must update before playing
//   (raising x needs a new APK: npm run publish-apk)
//
//   npm run publish-update -- --bump z     raise z, build, publish
//   npm run publish-update -- --bump y     raise y (z back to 0), build, publish
//   (if anything fails, package.json keeps its old version)
//   npm run publish-update                 build and publish package.json's version
//   npm run publish-update -- --skip-build publish the current dist/
//   npm run publish-update -- --server http://host:7330
//   npm run publish-update -- --test       test build (test servers only)
//
// It always builds with build type "release" (players), whatever
// VITE_BUILD_TYPE says in .env.android, unless --test is given.
//
// Only files the server does not have yet are uploaded. See update-server.mjs
// for the server address and publish key.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DIST, INFO_FILE, writeBundleInfo } from "./bundle-info.mjs";
import { ROOT, arg, connect, fail, sha256 } from "./update-server.mjs";

// Set once the server has accepted the release; from then on the new version
// is real and must stay in package.json, whatever happens afterwards.
let published = false;

function bump(part) {
  const file = path.join(ROOT, "package.json");
  const original = fs.readFileSync(file, "utf8");
  const pkg = JSON.parse(original);
  const [x, y, z] = pkg.version.split(".").map(Number);
  if (part === "z") pkg.version = `${x}.${y}.${z + 1}`;
  else if (part === "y") pkg.version = `${x}.${y + 1}.0`;
  else fail("--bump takes z or y (raising x needs a new APK: npm run publish-apk).");
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`Version raised to ${pkg.version}`);
  // If publishing fails, put the old version back so a retry does not skip one.
  process.on("exit", (code) => {
    if (code !== 0 && !published) {
      fs.writeFileSync(file, original);
      console.error(`Version restored to ${original.match(/"version":\s*"([^"]+)"/)[1]}`);
    }
  });
}

async function main() {
  const { server, uploadMissing, publish } = connect();
  const part = arg("--bump");
  if (part) bump(part);
  // Players get release builds. A test build only with --test (and only a
  // server with APP_UPDATE_ALLOW_TEST=true accepts it).
  const wantType = process.argv.includes("--test") ? "test" : "release";
  if (!process.argv.includes("--skip-build")) {
    console.log(`Building web code (mode android, build type ${wantType})...`);
    // An env var beats .env.android in Vite, so this overrides VITE_BUILD_TYPE there.
    const r = spawnSync("npm run build -- --mode android", { cwd: ROOT, stdio: "inherit", shell: true, env: { ...process.env, VITE_BUILD_TYPE: wantType } });
    if (r.status !== 0) fail("Build failed.");
  }
  if (!fs.existsSync(path.join(DIST, "index.html"))) fail("dist/index.html not found. Build first.");

  const { version, nativeKey, buildType, files } = writeBundleInfo();
  if (buildType !== wantType) {
    fail(buildType === "test"
      ? "dist/ is a TEST build (VITE_BUILD_TYPE=test). Rebuild without --skip-build, or pass --test to publish it to a test server."
      : "dist/ is a release build but --test was given.");
  }
  const infoData = fs.readFileSync(path.join(DIST, INFO_FILE));
  const all = [...files, { name: INFO_FILE, hash: sha256(infoData), size: infoData.length }];
  console.log(`Live update ${version} · ${buildType} · native ${nativeKey} · ${all.length} files · server ${server}`);

  await uploadMissing(all.map((f) => ({ ...f, read: () => fs.readFileSync(path.join(DIST, f.name)) })));
  await publish("/app-update/publish/release", { version, nativeKey, buildType, files: all.map(({ name, hash, size }) => ({ name, hash, size })) });
  published = true;
  console.log(`\n✔ Published live update ${version}. Players get the popup next time they open the game.`);
}

// No process.exit() on success: on Windows it can crash Node while network
// handles are still closing (Assertion failed ... src\win\async.c).
main().catch((error) => fail(error.stack || String(error)));
