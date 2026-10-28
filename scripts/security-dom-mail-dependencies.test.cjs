const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequire } = require("node:module");
const { generateKeyPairSync } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = join(__dirname, "..");
const desktop = createRequire(join(root, "artifacts/labtrax-desktop/package.json"));
const api = createRequire(join(root, "artifacts/api-server/package.json"));
const { JSDOM } = desktop("jsdom");
const createDOMPurify = desktop("dompurify");

test("desktop and API consumers resolve patched dependency releases", () => {
  assert.equal(createDOMPurify.version, "3.4.17");
  assert.equal(api("nodemailer/package.json").version, "10.2.0");
  assert.equal(desktop("electron/package.json").version, "42.11.18");
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  for (const vulnerable of ["dompurify@3.4.16:", "nodemailer@10.0.9:", "electron@42.11.4:"]) {
    assert.ok(!lockfile.includes(vulnerable), `${vulnerable} must not remain in the lockfile`);
  }
});

test("GHSA-cg2g-xh64-v4q7: scrub split template expressions in nested shadow roots", () => {
  const window = new JSDOM("<!doctype html><body></body>").window;
  try {
    for (const [first, last] of [
      ["$", "{alert(1)}"], ["{", "{alert(1)}}"], ["<", "%alert(1)%>"],
    ]) {
      const purifier = createDOMPurify(window);
      const host = window.document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      const nestedHost = window.document.createElement("div");
      const nestedShadow = nestedHost.attachShadow({ mode: "open" });
      for (const target of [shadow, nestedShadow]) {
        target.append(first, window.document.createElement("object"), last);
      }
      shadow.append(nestedHost);
      purifier.sanitize(host, { IN_PLACE: true, SAFE_FOR_TEMPLATES: true });
      for (const target of [shadow, nestedShadow]) {
        assert.ok(!target.textContent.includes(first + last));
        assert.equal(target.querySelector("object"), null);
      }
    }
  } finally {
    window.close();
  }
});

test("GHSA-mrv2-3pqr-j5jr: hooks cannot leave detached ancestor or sibling handlers armed", () => {
  const window = new JSDOM("<!doctype html><body></body>").window;
  try {
    for (const hook of [
      "beforeSanitizeElements", "uponSanitizeElement", "afterSanitizeElements",
      "beforeSanitizeAttributes", "afterSanitizeAttributes",
    ]) {
      for (const mode of ["self", "parent", "nextSibling"]) {
        const purifier = createDOMPurify(window);
        window.document.body.innerHTML = '<div id="root"><figure><img class="bad" src="a.png">' +
          '<img id="evil" src="x" onerror="alert(1)"></figure><p>ok</p></div>';
        const host = window.document.getElementById("root");
        const evil = window.document.getElementById("evil");
        purifier.addHook(hook, node => {
          if (node.getAttribute?.("class") !== "bad") return;
          if (mode === "self") node.remove();
          if (mode === "parent") node.parentNode?.remove();
          if (mode === "nextSibling") node.nextElementSibling?.remove();
        });
        purifier.sanitize(host, { IN_PLACE: true });
        assert.equal(evil.getAttribute("onerror"), null, `${hook}: ${mode}`);
        assert.equal(host.querySelector("p").textContent, "ok");
      }
    }
  } finally {
    window.close();
  }
});

test("GHSA-c6gr-qvv4-5v3f: XHTML SMIL cannot rewrite href", () => {
  const window = new JSDOM("<!doctype html><body></body>").window;
  try {
    const purifier = createDOMPurify(window);
    for (const tag of ["animate", "set"]) {
      const clean = purifier.sanitize(
        `<svg xmlns="http://www.w3.org/2000/svg"><a><${tag} attributeName="href" ` +
        'values="x;javascript:alert(1)" dur="0.01s" fill="freeze"/><text>click</text></a></svg>',
        {
          PARSER_MEDIA_TYPE: "application/xhtml+xml",
          ALLOWED_TAGS: ["svg", "a", tag, "text"],
          ALLOWED_ATTR: ["attributeName", "values", "dur", "fill"],
        },
      );
      assert.ok(!clean.includes('attributeName="href"'), clean);
      assert.ok(clean.includes("click"));
    }
    assert.equal(purifier.sanitize('<p>Hello <strong>lab</strong><script>alert(1)</script></p>'),
      "<p>Hello <strong>lab</strong></p>");
  } finally {
    window.close();
  }
});

test("GHSA-39m8-27wv-hr27: DKIM unfolding scans original lines, not growing strings", () => {
  // Count regex input characters instead of using a noisy wall-clock threshold.
  // Isolate instrumentation from the test runner and other security checks.
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const Parser = require(${JSON.stringify(api.resolve("nodemailer/lib/dkim/message-parser"))});
    const parser = new Parser();
    const folds = Array.from({ length: 5000 }, (_, i) => " recipient-" + i + "@example.com,");
    parser.rawHeaders = Buffer.from("To: first@example.com\\r\\n" + folds.join("\\r\\n") + "\\r\\nSubject: safe");
    const original = RegExp.prototype.test;
    let scanned = 0;
    let headers;
    try {
      RegExp.prototype.test = function(value) {
        scanned += String(value).length;
        return original.call(this, value);
      };
      headers = parser.parseHeaders();
    } finally {
      RegExp.prototype.test = original;
    }
    assert.deepEqual(headers.map(h => h.key), ["to", "subject"]);
    assert.equal(headers[0].line, "To: first@example.com\\n" + folds.join("\\n"));
    assert.equal(headers[1].line, "Subject: safe");
    assert.ok(scanned < parser.rawHeaders.length * 5, "quadratic rescanning: " + scanned);
  `], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("upgraded Nodemailer composes and DKIM-signs mail without an SMTP connection", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const transport = api("nodemailer").createTransport({
    streamTransport: true,
    buffer: true,
    dkim: { domainName: "example.com", keySelector: "security-test", privateKey },
  });
  const result = await transport.sendMail({
    from: "lab@example.com",
    to: "recipient@example.com",
    subject: "Security regression",
    text: "Plain text",
    html: "<p>Lab message</p>",
    attachments: [{ filename: "sample.txt", content: "Attachment" }],
  });
  const message = result.message.toString();
  assert.match(message, /DKIM-Signature:/);
  assert.match(message, /Subject: Security regression/);
  assert.match(message, /filename=sample.txt/);
  transport.close();
});
