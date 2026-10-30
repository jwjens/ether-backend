'use strict';
// Stranger tests: seats, licenses, machines. B's credentials aimed at A's resources: refused, or B's own data only;
// nothing of A's changed. The key in /licenses/:key/* IS the credential, so B's key goes there, aimed at A's machine.
const { runArea } = require("./lib/stranger");
const ownKeyAtAsMachine = (A, B) => ({ params: { key: B.key }, body: { machine_id: A.machine, machineId: A.machine } });
runArea("seats", {
  overrides: {
    "GET /licenses/:key/activations": ownKeyAtAsMachine,
    "POST /licenses/:key/deactivate": ownKeyAtAsMachine,
  },
});
