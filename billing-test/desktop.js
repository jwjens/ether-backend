'use strict';
// The EtherCast DEV build (C:\openair) for the billing test — launched and left running; the drivers attach over CDP
// (127.0.0.1:9333, chromium.connectOverCDP) to sign in, read the popup and take window captures.
//   node billing-test/desktop.js            (runs until killed; app output → billing-test/desktop-app.log)
//
//   · its own empty profile: ETHER_ISOLATED_DEV=1 + --user-data-dir (own userData, own engine pipe, no :3400) and
//     LOCALAPPDATA under billing-test\desktop-profile (own database, machine id and staged engine) — never the real one
//   · pointed at the LOCAL backend: ETHER_BACKEND_URL_DEV (main process); the renderer comes from the vite on :1420
//     started with VITE_ETHER_BACKEND_URL=http://127.0.0.1:8787
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const OPENAIR = "C:\\openair";
const PROFILE = path.join(__dirname, process.env.BT_PROFILE || "desktop-profile");
const CDP_PORT = 9333;

if (require.main === module) {
  for (const d of ["Roaming\\Ether", "Local"]) fs.mkdirSync(path.join(PROFILE, d), { recursive: true });
  const env = {
    ...process.env,
    LOCALAPPDATA: path.join(PROFILE, "Local"),
    NODE_ENV: "development",
    ETHER_ISOLATED_DEV: "1",
    ETHER_BACKEND_URL_DEV: `http://127.0.0.1:${process.env.BT_PORT || 8787}`,
    VITE_ETHER_BACKEND_URL: `http://127.0.0.1:${process.env.BT_PORT || 8787}`,
  };
  delete env.ETHER_ALLOW_DEV_PUSH; delete env.ETHER_SMOKE;
  const log = fs.createWriteStream(path.join(__dirname, "desktop-app.log"), { flags: "a" });
  const app = spawn(path.join(OPENAIR, "node_modules", "electron", "dist", "electron.exe"),
    [path.join(OPENAIR, "electron", "main.js"), `--user-data-dir=${path.join(PROFILE, "Roaming", "Ether")}`, `--remote-debugging-port=${CDP_PORT}`],
    { cwd: OPENAIR, env });
  app.stdout.pipe(log); app.stderr.pipe(log);
  console.log(`[desktop] started pid ${app.pid}; CDP on 127.0.0.1:${CDP_PORT}`);
  app.on("exit", (c) => { console.log(`[desktop] exited ${c}`); process.exit(0); });
  const stop = () => { try { app.kill(); } catch {} };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}

module.exports = { PROFILE, OPENAIR, CDP_PORT };
