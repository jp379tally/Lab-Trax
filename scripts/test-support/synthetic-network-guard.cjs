"use strict";

// Opt-in preload for owned synthetic checks. Deny external services (including
// local cloud sidecars and low-port SMTP/DB proxies); disposable PostgreSQL and
// test HTTP servers use high loopback ports. Never enable for real-cloud tests.
const net = require("node:net");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === "object"
    ? first
    : { port: first, host: typeof args[1] === "string" ? args[1] : "localhost" };
  const host = options.host || "localhost";
  const port = Number(options.port);
  if (options.path || !["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(host)
      || !Number.isInteger(port) || port < 20000) {
    const error = new Error("Non-test network access is disabled in this synthetic check.");
    error.code = "LABTRAX_SYNTHETIC_NETWORK_DENIED";
    throw error;
  }
  return originalConnect.apply(this, args);
};

if (require.main === module) {
  const assert = require("node:assert/strict");
  assert.throws(() => net.connect({ host: "example.invalid", port: 443 }),
    { code: "LABTRAX_SYNTHETIC_NETWORK_DENIED" });
  assert.throws(() => net.connect({ host: "127.0.0.1", port: 1106 }),
    { code: "LABTRAX_SYNTHETIC_NETWORK_DENIED" });
  const server = net.createServer(socket => socket.end("synthetic"));
  server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1");
    let result = "";
    socket.on("data", bytes => { result += bytes; });
    socket.on("end", () => {
      assert.equal(result, "synthetic");
      server.close(() => console.log("Synthetic network guard: 3 assertions passed."));
    });
  });
}
