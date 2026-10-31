#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const ROOT = process.env.MB_ROOT || process.cwd();

const args = process.argv.slice(2);
const cmd = args[0];

function runScript(scriptRelativePath, extraArgs = []) {
  const fullPath = path.join(PKG_ROOT, scriptRelativePath);
  const child = spawn(process.execPath, [fullPath, ...extraArgs], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      MB_ROOT: ROOT,
      MB_UI: path.join(PKG_ROOT, "src"),
    },
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

if (cmd === "add-exe") {
  const src = path.join(PKG_ROOT, "launcher", "AppBuilder.exe");
  const destName = args[1] || "AppBuilder.exe";
  const dest = path.join(ROOT, destName);
  if (!fs.existsSync(src)) {
    console.error("Launcher binary not found at", src);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.log(`Launcher created at: ${dest}`);
} else if (cmd === "publish-update") {
  runScript("scripts/publish-update.mjs", args.slice(1));
} else if (cmd === "publish-apk") {
  runScript("scripts/publish-apk.mjs", args.slice(1));
} else if (cmd === "releases") {
  runScript("scripts/releases.mjs", args.slice(1));
} else if (cmd === "bundle-info") {
  const { writeBundleInfo } = await import(path.join(PKG_ROOT, "scripts", "bundle-info.mjs"));
  writeBundleInfo();
  console.log("Bundle info updated.");
} else if (cmd === "--help" || cmd === "-h") {
  console.log(`
Capacitor Android Builder CLI

Usage:
  capacitor-builder                  Start the visual builder interface (GUI)
  capacitor-builder add-exe [name]   Copy AppBuilder.exe launcher into this project
  capacitor-builder publish-update   Publish a live update (web assets)
  capacitor-builder publish-apk      Publish a newly built APK
  capacitor-builder releases         Manage and view published releases
  capacitor-builder bundle-info      Generate bundle.json stamp for live updates

Options:
  --port <number>     Port for the local web builder server (default: 5179)
  --no-open           Do not automatically open the browser window
  --help, -h          Show this help message
`);
} else {
  // Default: start the builder GUI server
  runScript("src/server.mjs", args);
}
