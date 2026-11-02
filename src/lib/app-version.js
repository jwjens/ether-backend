'use strict';
// WHICH ETHER VERSION A DEVICE RUNS (Jeff, 2026-11-01): read from the desktop's own requests and recorded on its device
// row (license_activations.app_version), shown on the platform's Licenses page. Existing rows are never back-filled.
//   1. body.app_version — sent explicitly by builds from 2026-11-01 on
//   2. the x-ether-version header
//   3. the app's token in the User-Agent — every Electron build sends "<app name>/<version>" there by default (4.6.57 does
//      not change it), so older builds report their version without any change. The name is "Ether" (productName) or
//      "openair" (the package name), depending on how the build was packaged; both are accepted. Electron's own token
//      ("Electron/x.y.z") is not an Ether version and is never taken.
// Anything that is not a plain version (1.2.3, optionally -beta.1) is ignored, never stored.
const VERSION = /^\d{1,3}\.\d{1,4}\.\d{1,5}(?:-[0-9A-Za-z.]{1,20})?$/;
const UA_TOKEN = /(?:^|\s)(?:Ether|EtherCast|openair)\/(\d{1,3}\.\d{1,4}\.\d{1,5}(?:-[0-9A-Za-z.]{1,20})?)(?:\s|$)/;

function clean(v) {
  const s = String(v == null ? "" : v).trim();
  return VERSION.test(s) ? s : null;
}

/** The Ether version a request came from, or null. */
function appVersionOf(req) {
  return clean(req && req.body && req.body.app_version)
    || clean(req && req.headers && req.headers["x-ether-version"])
    || (() => { const m = UA_TOKEN.exec(String((req && req.headers && req.headers["user-agent"]) || "")); return m ? clean(m[1]) : null; })();
}

module.exports = { appVersionOf };
