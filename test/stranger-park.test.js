'use strict';
// Stranger tests: Park page. B's credentials aimed at A's station: refused, nothing of A's changed. A wrong PIN on A's
// Park login is counted against A's operator by design (the lockout rule, Remote page → Users → Login safety) — only
// those two columns may change.
const { runArea } = require("./lib/stranger");
runArea("park", {
  overrides: {
    "POST /public/ops/:slug/login": { ignoreColumns: { account_users: ["failed_attempts", "locked_until", "updated_at"] } },
  },
});
