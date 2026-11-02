'use strict';
// What the desktop's sign-in gets: POST /api/user/desktop-activate, then /account/connect with the key it returns.
const L = require("./lib");
(async () => {
  const email = process.argv[2];
  const a = await L.api("POST", "/api/user/desktop-activate", { email, password: L.PASSWORD, machine_id: "probe-m", machine_name: "probe", session: true });
  const key = a.body && (a.body.license_key || a.body.key);
  console.log("activate", a.status, JSON.stringify({ ...a.body, license_key: key ? key.slice(0, 12) + "…" : key, token: a.body && a.body.token ? "(token)" : undefined, session: a.body && a.body.session ? "(session)" : undefined }));
  const c = await L.api("POST", "/account/connect", { license_key: key, machine_id: "probe-m" });
  console.log("connect", c.status, JSON.stringify(c.body).slice(0, 400));
  console.log("rows", JSON.stringify(await L.db(`SELECT id, plan, active, key_prefix, license_key IS NOT NULL AS has_plain, key_hash IS NOT NULL AS has_hash, expires_at, stripe_subscription_id FROM licenses ORDER BY id`)));
})();
