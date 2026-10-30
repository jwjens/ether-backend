'use strict';
// Every route the real app serves, read from Express's own router (not a grep): [{ method, path, guards }].
// `guards` = the names of the route's handlers before the last (requireAuth, requireUser, …), for the inventory review.
function mountPath(layer) {
  if (!layer.regexp || layer.regexp.fast_slash) return "";
  // Express 4 mount regexp source: ^\/prefix\/?(?=\/|$)  →  /prefix
  const m = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  return m ? m[1].replace(/\\\//g, "/") : `<${layer.regexp.source}>`;
}
function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const hs = layer.route.stack.map(s => s.name || "<anon>");
      for (const method of Object.keys(layer.route.methods).filter(m => layer.route.methods[m])) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, guards: hs.slice(0, -1) });
      }
    } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
  return out;
}
function listRoutes(app) {
  const seen = new Set();
  return walk(app._router.stack, "", []).filter(r => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
module.exports = { listRoutes };
