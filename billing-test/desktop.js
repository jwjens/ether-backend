'use strict';
// The EtherCast DEV build (C:\openair) for the billing test, driven by Playwright's Electron driver.
//   · its own empty profile (APPDATA and LOCALAPPDATA under billing-test\desktop-profile) — never the real one
//   · pointed at the LOCAL backend (ETHER_BACKEND_URL_DEV / VITE_ETHER_BACKEND_URL = http://127.0.0.1:8787; the vite dev
//     server on :1420 must be started with VITE_ETHER_BACKEND_URL set — see run notes)
// Window captures: the app window's own screenshot (page.screenshot), saved by lib.shot.
const fs = require("node:fs");
const path = require("node:path");
const PW = process.env.PW_DIR || "C:\\Users\\jensj\\AppData\\Local\\Temp\\claude\\C--openair\\d859f1fc-74c8-4861-901b-87db15ad2780\\scratchpad\\pw\\node_modules\\playwright-core";
const { _electron } = require(PW);

const OPENAIR = "C:\\openair";
const PROFILE = path.join(__dirname, "desktop-profile");

async function launch() {
  for (const d of ["Roaming", "Local"]) fs.mkdirSync(path.join(PROFILE, d), { recursive: true });
  const env = {
    ...process.env,
    APPDATA: path.join(PROFILE, "Roaming"),
    LOCALAPPDATA: path.join(PROFILE, "Local"),
    NODE_ENV: "development",
    ETHER_BACKEND_URL_DEV: "http://127.0.0.1:8787",
    VITE_ETHER_BACKEND_URL: "http://127.0.0.1:8787",
  };
  delete env.ETHER_ALLOW_DEV_PUSH;
  const app = await _electron.launch({
    executablePath: path.join(OPENAIR, "node_modules", "electron", "dist", "electron.exe"),
    args: [path.join(OPENAIR, "electron", "main.js")],
    cwd: OPENAIR, env, timeout: 120000,
  });
  const logs = [];
  app.process().stdout.on("data", (d) => logs.push(String(d)));
  app.process().stderr.on("data", (d) => logs.push(String(d)));
  const win = await app.firstWindow({ timeout: 120000 });
  await win.waitForLoadState("domcontentloaded");
  return { app, win, logs, PROFILE };
}

module.exports = { launch, PROFILE, OPENAIR };
