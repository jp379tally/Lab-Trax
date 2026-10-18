const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequire } = require("node:module");
const { generateKeyPairSync } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createServer, get } = require("node:http");
const { once } = require("node:events");

// Exercise installed transitive packages, not the temporary patch sources.
const root = join(__dirname, "..");
const requireHoistedDependency = createRequire(
  join(root, "node_modules/.pnpm/node_modules/security-check.cjs"),
);
const requireApi = createRequire(join(root, "artifacts/api-server/package.json"));
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
const patchedVersions = {
  braces: "3.0.3",
  "node-forge": "1.4.0",
  "sprintf-js": "1.1.3",
  "http-cache-semantics": "4.3.0",
};

function patchedPackagePath(name) {
  const version = patchedVersions[name];
  const snapshot = lockfile.split("\nsnapshots:\n")[1]
    .split("\n").find(line => line.startsWith(`  ${name}@${version}(patch_hash=`));
  assert.ok(snapshot, `${name} must have a patched lockfile snapshot`);
  const hash = snapshot.match(/patch_hash=([a-f0-9]+)\)/)[1];
  return join(root, "node_modules/.pnpm",
    `${name}@${version}_patch_hash=${hash}`, "node_modules", name);
}

function requireDependency(name) {
  // Never fall back to stale unpatched root copies when a hoist link is absent.
  return name in patchedVersions
    ? require(patchedPackagePath(name))
    : requireHoistedDependency(name);
}

test("dependency consumers resolve the lockfile-pinned source patches", () => {
  for (const [consumer, version, dependency] of [
    ["micromatch", "4.0.8", "braces"],
    ["argparse", "1.0.10", "sprintf-js"],
    ["roarr", "2.15.4", "sprintf-js"],
    ["@expo/code-signing-certificates", "0.0.6", "node-forge"],
    ["cacheable-request", "7.0.4", "http-cache-semantics"],
  ]) {
    const consumerManifest = join(root, "node_modules/.pnpm",
      `${consumer.replace("/", "+")}@${version}`, "node_modules", consumer, "package.json");
    assert.equal(JSON.parse(readFileSync(consumerManifest, "utf8")).version, version);
    const consumerRequire = createRequire(consumerManifest);
    assert.equal(consumerRequire.resolve(dependency),
      require.resolve(patchedPackagePath(dependency)),
      `${consumer} must use patched ${dependency}`);
  }
});

test("lockfile retains patched releases, native binaries, and all source patches", () => {
  for (const [name, version] of Object.entries({
    "proxy-addr": "2.0.8",
    "source-map-js": "1.2.2",
    "http-cache-semantics": "4.3.0",
    "shell-quote": "1.12.0",
    compression: "1.8.2",
    sharp: "0.35.5",
    "fast-copy": "4.1.2",
    "postcss-selector-parser": "7.1.6",
  })) {
    assert.ok(lockfile.includes(`  ${name}@${version}:`), `${name} patched version`);
  }
  for (const name of ["braces@3.0.3", "node-forge@1.4.0", "sprintf-js@1.1.3", "http-cache-semantics@4.3.0"]) {
    assert.ok(lockfile.includes(`path: patches/${name}.patch`), `${name} tracked patch`);
    assert.ok(lockfile.includes(`${name}(patch_hash=`), `${name} patched dependency edge`);
  }
  assert.ok(!lockfile.includes("sprintf-js@1.0.3"), "no legacy sprintf package");
  const snapshots = lockfile.split("\nsnapshots:\n")[1];
  assert.ok(!snapshots.includes("  sprintf-js@1.1.3:"), "no unpatched sprintf snapshot");
  assert.match(lockfile, /'@img\/sharp-linux-x64': 0\.35\.5/);
  assert.match(lockfile, /'@img\/sharp-libvips-linux-x64': 1\.3\.4/);
});

test("proxy-addr rejects IPv4 matching overly broad IPv6 trust ranges", () => {
  const proxyaddr = requireDependency("proxy-addr");
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    assert.equal(proxyaddr.compile(subnet)("203.0.113.5"), false);
  }
  assert.equal(proxyaddr.compile("10.0.0.0/8")("10.1.2.3"), true);
  assert.equal(proxyaddr.compile("::ffff:10.0.0.0/104")("10.1.2.3"), true);
});

test("source maps reject huge and non-integer section offsets", () => {
  const { SourceMapConsumer } = requireDependency("source-map-js");
  for (const line of [Number.MAX_SAFE_INTEGER, Infinity, -1, 0.5]) {
    assert.throws(() => new SourceMapConsumer({
      version: 3,
      sections: [{
        offset: { line, column: 0 },
        map: { version: 3, sources: [], names: [], mappings: "" },
      }],
    }), /offset/i);
  }
});

test("shell quoting refuses a line break after a comment token", () => {
  const { quote } = requireDependency("shell-quote");
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.throws(() => quote(["echo", "ok", { comment: "x" }, `a${terminator}id;#`]), TypeError);
  }
  assert.equal(quote(["echo", "hello world"]), "echo 'hello world'");
});

test("shared HTTP cache cannot reuse a security-zeroed Set-Cookie response with max-stale", () => {
  const CachePolicy = requireDependency("http-cache-semantics");
  const policy = new CachePolicy(
    { url: "/account", method: "GET", headers: { host: "example.test" } },
    { status: 200, headers: {
      "set-cookie": "session=test-only",
      "last-modified": new Date(Date.now() - 86400000).toUTCString(),
    } },
    { shared: true },
  );
  assert.equal(policy.maxAge(), 0);
  assert.equal(policy.satisfiesWithoutRevalidation({
    url: "/account", method: "GET",
    headers: { host: "example.test", "cache-control": "max-stale=999999999" },
  }), false);
});

test("cache security rules survive serialization and still allow safe max-stale reuse", () => {
  const CachePolicy = requireDependency("http-cache-semantics");
  const request = { url: "/account", method: "GET", headers: { host: "example.test" } };
  for (const headers of [
    { "cache-control": "no-store" },
    { "cache-control": "private" },
    { "cache-control": "no-cache" },
    { "cache-control": "proxy-revalidate" },
    { vary: "*" },
    { "set-cookie": "session=test-only" },
  ]) {
    const policy = new CachePolicy(request, { status: 200, headers }, { shared: true });
    const restored = CachePolicy.fromObject(policy.toObject());
    for (const current of [policy, restored]) {
      for (const maxStale of ["max-stale", "max-stale=999999999"]) {
        assert.equal(current.satisfiesWithoutRevalidation({
          ...request, headers: { ...request.headers, "cache-control": maxStale },
        }), false);
      }
    }
  }
  const safe = new CachePolicy(request, {
    status: 200, headers: { "cache-control": "public, max-age=1", age: "10" },
  });
  assert.equal(safe.satisfiesWithoutRevalidation({
    ...request, headers: { ...request.headers, "cache-control": "max-stale=20" },
  }), true);
});

test("security-zeroed responses cannot use stale-if-error or stale-while-revalidate", () => {
  const CachePolicy = requireDependency("http-cache-semantics");
  const request = { url: "/account", method: "GET", headers: { host: "example.test" } };
  for (const securityHeaders of [
    { "set-cookie": "session=test-only" },
    { "cache-control": "no-store" },
    { "cache-control": "private" },
    { "cache-control": "no-cache" },
    { "cache-control": "proxy-revalidate" },
    { "cache-control": "must-revalidate" },
    { vary: "*" },
  ]) {
    const headers = {
      ...securityHeaders,
      "cache-control": [
        securityHeaders["cache-control"],
        "stale-if-error=3600", "stale-while-revalidate=3600",
      ].filter(Boolean).join(", "),
    };
    const policy = new CachePolicy(request, { status: 200, headers }, { shared: true });
    for (const current of [policy, CachePolicy.fromObject(policy.toObject())]) {
      assert.equal(current.useStaleWhileRevalidate(), false);
      for (const status of [500, 502, 503, 504]) {
        const result = current.revalidatedPolicy(request, { status, headers: {} });
        assert.equal(result.modified, true);
        assert.equal(result.matches, false);
        assert.notEqual(result.policy, current);
      }
    }
  }
  const publicPolicy = new CachePolicy(request, {
    status: 200,
    headers: { "cache-control": "public, max-age=1, stale-if-error=3600", age: "10" },
  });
  assert.equal(publicPolicy.revalidatedPolicy(request, { status: 503, headers: {} }).modified, false);
});

test("installed cacheable-request never revives another user's legacy cache entry on 503 or 304", { timeout: 10000 }, async (t) => {
  const CacheableRequest = requireDependency("cacheable-request");
  const CachePolicy = requireDependency("http-cache-semantics");
  const Keyv = requireDependency("keyv");
  const store = new Map();
  let requests = 0;
  let secondStatus = 503;
  let secondHeaders;
  const server = createServer((req, res) => {
    requests++;
    if (req.headers.cookie === "user=first") {
      res.setHeader("Set-Cookie", "session=first-test-only");
      res.setHeader("Cache-Control", "stale-if-error=3600");
      res.setHeader("ETag", '"first-only"');
      res.end("first user's private body");
    } else {
      secondHeaders = req.headers;
      res.statusCode = secondStatus;
      res.end("origin unavailable");
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const cacheable = new CacheableRequest(get, store);
  async function request(cookie) {
    return new Promise((resolve, reject) => {
      const event = cacheable({
        protocol: "http:", hostname: "127.0.0.1", port: server.address().port,
        path: "/account", headers: { cookie }, shared: true,
      }, async (res) => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(Buffer.from(chunk));
          resolve({
            status: res.statusCode, headers: res.headers, fromCache: res.fromCache,
            body: Buffer.concat(chunks).toString(),
          });
        } catch (error) { reject(error); }
      });
      event.once("error", reject);
      event.once("request", (req) => req.once("error", reject));
    });
  }
  assert.equal((await request("user=first")).body, "first user's private body");
  assert.equal(store.size, 0, "new private responses never enter the shared cache");
  // Plant the serialized entry that an earlier vulnerable install retained.
  const url = `http://127.0.0.1:${server.address().port}/account`;
  const policy = new CachePolicy({
    url, method: "GET", headers: { host: `127.0.0.1:${server.address().port}`, cookie: "user=first" },
  }, {
    status: 200, headers: {
      "set-cookie": "session=first-test-only", etag: '"first-only"',
      "last-modified": "Wed, 01 Oct 2025 00:00:00 GMT",
      "cache-control": "stale-if-error=3600",
    },
  }, { shared: true });
  const legacyCache = new Keyv({ store, namespace: "cacheable-request" });
  for (const status of [503, 304]) {
    secondStatus = status;
    await legacyCache.set(`GET:${url}`, {
      cachePolicy: policy.toObject(), url, statusCode: 200,
      body: Buffer.from("first user's private body"),
    });
    assert.equal(store.size, 1);
    const second = await request("user=second");
    assert.equal(second.status, status);
    assert.equal(second.fromCache, false);
    assert.equal(second.body, status === 503 ? "origin unavailable" : "");
    assert.equal(second.headers["set-cookie"], undefined);
    assert.equal(secondHeaders["if-none-match"], undefined);
    assert.equal(secondHeaders["if-modified-since"], undefined);
  }
  assert.equal(requests, 3, "each second-user request reaches the origin");
});

test("eligible cached responses still support legitimate conditional revalidation", () => {
  const CachePolicy = requireDependency("http-cache-semantics");
  const request = { url: "/public", method: "GET", headers: { host: "example.test" } };
  for (const cacheControl of ["public, max-age=0", "no-cache", "must-revalidate", "proxy-revalidate"]) {
    const policy = new CachePolicy(request, {
      status: 200, headers: { etag: '"public-data"', "cache-control": cacheControl },
    });
    assert.equal(policy.revalidationHeaders(request)["if-none-match"], '"public-data"');
    const result = policy.revalidatedPolicy(request, {
      status: 304, headers: { etag: '"public-data"' },
    });
    assert.equal(result.modified, false);
    assert.equal(result.matches, true);
  }
});

test("fast-copy stops at its explicit depth guard", () => {
  const { copy, copyStrict, MaxDepthExceededError } = requireDependency("fast-copy");
  let value = {};
  for (let i = 0; i < 1200; i++) value = { child: value };
  for (const copier of [copy, copyStrict]) {
    assert.throws(() => copier(value), MaxDepthExceededError);
    assert.deepEqual(copier({ child: [1, 2] }), { child: [1, 2] });
  }
});

test("selector parser preserves normal selectors and handles many flat class indexes", () => {
  const parser = requireDependency("postcss-selector-parser");
  for (const selector of ["a:hover > .item, #main", ".a".repeat(20000)]) {
    assert.equal(parser().processSync(selector), selector);
  }
});

test("compression destroys its zlib stream when the client aborts", { timeout: 10000 }, async (t) => {
  const zlib = require("node:zlib");
  const descriptor = Object.getOwnPropertyDescriptor(zlib, "createGzip");
  let gzipStream;
  Object.defineProperty(zlib, "createGzip", {
    ...descriptor,
    value: (...args) => {
      gzipStream = descriptor.value(...args);
      return gzipStream;
    },
  });
  t.after(() => Object.defineProperty(zlib, "createGzip", descriptor));
  const compression = requireApi("compression")({ threshold: 0 });
  const server = createServer((req, res) => compression(req, res, () => {
    res.setHeader("Content-Type", "text/plain");
    res.write("x".repeat(65536));
    res.flush();
    // Leave the response open to reproduce a premature disconnect.
  }));
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const closed = new Promise((resolve, reject) => {
    const request = get({
      hostname: "127.0.0.1", port: server.address().port,
      headers: { "Accept-Encoding": "gzip" },
    }, (res) => {
      assert.equal(res.headers["content-encoding"], "gzip");
      res.once("data", () => res.destroy());
      res.once("close", resolve);
    });
    request.once("error", reject);
    t.after(() => request.destroy());
  });
  await closed;
  assert.ok(gzipStream, "response used a real gzip stream");
  if (!gzipStream.destroyed) await once(gzipStream, "close");
  assert.equal(gzipStream.destroyed, true);
});

test("sharp uses patched librsvg and can decode SVG and resize an image", async () => {
  const sharp = requireApi("sharp");
  assert.equal(sharp.versions.sharp, "0.35.5");
  assert.equal(sharp.versions.rsvg, "2.63.2");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
  const { info } = await sharp(svg).resize(2, 2).png().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 2);
  assert.equal(info.height, 2);
});

test("braces protects string and direct AST entry points without breaking normal patterns", () => {
  const braces = requireDependency("braces");
  assert.deepEqual(braces.expand("x{a,b}{1..2}"), ["xa1", "xa2", "xb1", "xb2"]);
  assert.equal(braces.compile("x{a,b}"), "x(a|b)");
  assert.equal(braces.stringify(braces.parse("x{a,b}")), "x{a,b}");
  const allowedNesting = "(".repeat(120) + "x" + ")".repeat(120);
  assert.equal(braces.stringify(braces.parse(allowedNesting)), allowedNesting);
  assert.equal(braces.compile(allowedNesting), allowedNesting);
  for (const pattern of [
    "{".repeat(4000) + "a,b" + "}".repeat(4000),
    "(".repeat(4000) + "a" + ")".repeat(4000),
    "{".repeat(5000) + "a",
    "(".repeat(5000) + "a",
    "{(".repeat(2000) + "a,b" + ")}".repeat(2000),
  ]) {
    for (const fn of [braces, braces.parse, braces.compile, braces.expand]) {
      assert.throws(() => fn(pattern), { name: "SyntaxError", message: /nesting depth/ });
    }
  }
  function makeAst() {
    let node = { type: "text", value: "x", nodes: [] };
    for (let i = 0; i < 5000; i++) {
      const parent = { type: "brace", nodes: [node], ranges: 0 };
      node.parent = parent;
      node = parent;
    }
    const rootNode = { type: "root", nodes: [node] };
    node.parent = rootNode;
    return rootNode;
  }
  for (const fn of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => fn(makeAst()), { name: "SyntaxError", message: /nesting depth/ });
  }
});

test("micromatch's brace expansion rejects malicious nesting through its installed dependency", () => {
  const micromatch = requireDependency("micromatch");
  assert.deepEqual(micromatch.braceExpand("file-{a,b}.txt"), ["file-a.txt", "file-b.txt"]);
  assert.deepEqual(micromatch(["file-a.txt", "file-c.txt"], "file-{a,b}.txt"), ["file-a.txt"]);
  // Without braces micromatch returns the literal unchanged, never invoking
  // the recursive brace parser.
  const literal = "(".repeat(4000) + "a" + ")".repeat(4000);
  assert.deepEqual(micromatch.braces(literal), [literal]);
  for (const pattern of [
    "{".repeat(4000) + "a,b" + "}".repeat(4000),
    "{(".repeat(2000) + "a,b" + ")}".repeat(2000),
  ]) {
    for (const options of [{}, { expand: true }]) {
      assert.throws(() => micromatch.braces(pattern, options), {
        name: "SyntaxError", message: /nesting depth/,
      });
    }
  }
});

test("sprintf validates numeric precision before native formatting, preserving legacy API", () => {
  const { sprintf, vsprintf } = requireDependency("sprintf-js");
  for (const type of ["e", "f", "g"]) {
    for (const precision of ["101", "1000000000", "9".repeat(400)]) {
      assert.throws(() => sprintf(`%.${precision}${type}`, 1.23), {
        name: "TypeError", message: /numeric precision/,
      });
    }
  }
  assert.throws(() => sprintf("%.0g", 1), TypeError);
  assert.equal(sprintf("%.2f", 1.234), "1.23");
  assert.equal(sprintf("%.0f", 1.9), "2");
  assert.equal(sprintf("%.0e", 1.9), "2e+0");
  // The inclusive ECMAScript limit remains valid for all three native methods.
  for (const [type, method] of [
    ["e", "toExponential"], ["f", "toFixed"], ["g", "toPrecision"],
  ]) {
    const nativeResult = (1.23)[method](100);
    // Legacy %g intentionally removes trailing zeros by converting to Number.
    const expected = type === "g" ? String(Number(nativeResult)) : nativeResult;
    assert.equal(sprintf(`%.100${type}`, 1.23), expected);
    assert.equal(vsprintf(`%.100${type}`, [1.23]), expected);
    assert.throws(() => vsprintf(`%.101${type}`, [1.23]), {
      name: "TypeError", message: /numeric precision/,
    });
  }
  assert.equal(sprintf("%(person.name)s", { person: { name: "test" } }), "test");
  assert.equal(vsprintf("%s: %04d", ["test", 12]), "test: 0012");
});

test("sprintf rejects invalid precision before evaluating caller-provided functions", () => {
  const { sprintf, vsprintf } = requireDependency("sprintf-js");
  let calls = 0;
  const value = () => { calls++; return 1.23; };
  for (const format of ["%.101e", "%.101f", "%.101g", "%.0g"]) {
    assert.throws(() => sprintf(format, value), {
      name: "TypeError", message: /numeric precision/,
    });
    assert.throws(() => vsprintf(format, [value]), {
      name: "TypeError", message: /numeric precision/,
    });
  }
  // Parsing must reject the entire format before evaluating even an earlier,
  // otherwise valid placeholder. Repeated failures must not poison the cache.
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const type of ["e", "f", "g"]) {
      const format = `%.2f %.101${type}`;
      assert.throws(() => sprintf(format, value, value), {
        name: "TypeError", message: /numeric precision/,
      });
      assert.throws(() => vsprintf(format, [value, value]), {
        name: "TypeError", message: /numeric precision/,
      });
    }
  }
  assert.equal(calls, 0, "malformed formats must fail during parsing");
  assert.equal(sprintf("%.2f", value), "1.23");
  assert.equal(calls, 1, "valid formats retain function argument support");
});

test("roarr rejects malicious precision through its real logging consumer and recovers", () => {
  // Initialize roarr's own shared state, without enabling its stdout writer.
  requireDependency("roarr");
  const { default: createLogger } = requireDependency("roarr/dist/factories/createLogger");
  const messages = [];
  const log = createLogger(message => messages.push(message));
  let calls = 0;
  const value = () => { calls++; return 1.23; };
  for (const type of ["e", "f", "g"]) {
    for (const precision of ["101", "9".repeat(400)]) {
      const format = `%.2f %.${precision}${type}`;
      assert.throws(() => log(format, value, value), {
        name: "TypeError", message: /numeric precision/,
      });
      assert.throws(() => log({ source: "test" }, format, value, value), {
        name: "TypeError", message: /numeric precision/,
      });
    }
  }
  assert.equal(calls, 0, "logging must reject the format before invoking values");
  assert.equal(messages.length, 0, "invalid formats must not emit partial messages");
  log("amount %.2f", value);
  log({ source: "test" }, "amount %.2f", value);
  assert.deepEqual(messages.map(message => message.message), ["amount 1.23", "amount 1.23"]);
  assert.equal(messages[1].context.source, "test");
  assert.equal(calls, 2);
});

test("node-forge rejects extra DigestAlgorithm elements and invalid NULL parameters", () => {
  const forge = requireDependency("node-forge");
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 1024, publicExponent: 3,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  const a = forge.asn1;
  const element = (type, constructed, value) => a.create(a.Class.UNIVERSAL, type, constructed, value);
  for (const algorithm of ["sha1", "sha256", "sha512", "md5"]) {
    const md = forge.md[algorithm].create().update("security regression");
    const digest = md.digest().getBytes();
    assert.equal(publicKey.verify(digest, privateKey.sign(md)), true);
    const oid = element(a.Type.OID, false, a.oidToDer(forge.oids[algorithm]).getBytes());
    const nullParam = element(a.Type.NULL, false, "");
    const garbage = element(a.Type.OCTETSTRING, false, "garbage");
    for (const parameters of [
      [],
      [nullParam],
      [oid, nullParam, garbage],
      [oid, garbage],
      [oid, element(a.Type.NULL, false, "garbage")],
      [oid, element(a.Type.NULL, true, [])],
      [oid, a.create(a.Class.CONTEXT_SPECIFIC, a.Type.NULL, false, "")],
      [oid, nullParam, nullParam],
    ]) {
      const der = a.toDer(element(a.Type.SEQUENCE, true, [
        element(a.Type.SEQUENCE, true, parameters),
        element(a.Type.OCTETSTRING, false, digest),
      ])).getBytes();
      // Valid RSA signature of deliberately malformed DigestInfo.
      const signature = privateKey.sign(der, "NONE");
      assert.throws(() => publicKey.verify(digest, signature), /DigestInfo/);
    }
    if (algorithm !== "md5") {
      const der = a.toDer(element(a.Type.SEQUENCE, true, [
        element(a.Type.SEQUENCE, true, [oid]),
        element(a.Type.OCTETSTRING, false, digest),
      ])).getBytes();
      assert.equal(publicKey.verify(digest, privateKey.sign(der, "NONE")), true);
    }
  }
});
