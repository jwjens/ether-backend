'use strict';
// Stranger tests: remote. B's credentials aimed at A's resources: refused, or B's own data only; nothing of A's changed.
const { runArea } = require("./lib/stranger");
runArea("remote");
