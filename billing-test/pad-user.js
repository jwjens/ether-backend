'use strict';
// Rerun only: one placeholder account first, so the rerun's users get ids above the first server's (test10 = user 1) —
// both `stripe listen` sessions get every event, and a checkout message carries the user id.
const L = require("./lib");
(async () => { await L.signup("rerun-pad@ether.test", "Rerun pad"); console.log(JSON.stringify(await L.db("SELECT id, email FROM users ORDER BY id"))); })();
