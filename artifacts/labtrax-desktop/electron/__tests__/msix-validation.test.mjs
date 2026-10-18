import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  parseStoreVersion,
  renderStoreManifest,
  validateMsixBuffer,
  validateStoreIdentity,
} from "../../scripts/lib/msix-validation.mjs";

const expectedIdentity = {
  identityName: "LabTrax.Store",
  publisher: "CN=LabTrax Publisher",
  publisherDisplayName: "LabTrax",
  version: "1.0.6.143",
};

function minimalPng(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function x64Pe() {
  const buffer = Buffer.alloc(0x80);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write("PE\u0000\u0000", 0x40, "ascii");
  buffer.writeUInt16LE(0x8664, 0x44);
  return buffer;
}

async function createPackage({ signature = false, manifest = null } = {}) {
  const zip = new JSZip();
  zip.file(
    "AppxManifest.xml",
    manifest ??
      renderStoreManifest({
        ...expectedIdentity,
      }),
  );
  zip.file("AppxBlockMap.xml", "<BlockMap />");
  zip.file("LabTrax.exe", x64Pe());
  zip.file("resources/app.asar", "electron payload");
  zip.file("Assets/StoreLogo.png", minimalPng(50, 50));
  zip.file("Assets/Square44x44Logo.png", minimalPng(44, 44));
  zip.file("Assets/Square150x150Logo.png", minimalPng(150, 150));
  zip.file("Assets/Wide310x150Logo.png", minimalPng(310, 150));
  if (signature) zip.file("AppxSignature.p7x", "unexpected signature");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("Microsoft Store package metadata validation", () => {
  it("accepts a correctly identified x64 package with Store signing expectations", async () => {
    const report = await validateMsixBuffer(await createPackage(), expectedIdentity);
    expect(report).toMatchObject({
      identityName: expectedIdentity.identityName,
      publisher: expectedIdentity.publisher,
      version: expectedIdentity.version,
      architecture: "x64",
      capabilities: ["internetClient", "runFullTrust"],
      signature: "unsigned-for-microsoft-store-signing",
    });
  });

  it("rejects a mismatched Partner Center publisher", async () => {
    await expect(
      validateMsixBuffer(await createPackage(), {
        ...expectedIdentity,
        publisher: "CN=Different Publisher",
      }),
    ).rejects.toThrow('MSIX package identity Publisher is "CN=LabTrax Publisher"');
  });

  it("rejects a mismatched Partner Center publisher display name", async () => {
    const manifest = renderStoreManifest({
      ...expectedIdentity,
      publisherDisplayName: "Different Publisher",
    });
    await expect(
      validateMsixBuffer(await createPackage({ manifest }), expectedIdentity),
    ).rejects.toThrow('publisher display name is "Different Publisher"');
  });

  it("validates publisher display names containing XML-special characters", async () => {
    const identity = {
      ...expectedIdentity,
      publisherDisplayName: "Lab & Dental",
    };
    const manifest = renderStoreManifest(identity);
    await expect(
      validateMsixBuffer(await createPackage({ manifest }), identity),
    ).resolves.toMatchObject({
      identityName: identity.identityName,
      publisher: identity.publisher,
    });
  });

  it("rejects a package signed before Store submission", async () => {
    await expect(
      validateMsixBuffer(await createPackage({ signature: true }), expectedIdentity),
    ).rejects.toThrow("must be unsigned");
  });

  it("rejects a package missing a required capability", async () => {
    const manifest = renderStoreManifest(expectedIdentity).replace(
      '<Capability Name="internetClient" />',
      "",
    );
    await expect(
      validateMsixBuffer(await createPackage({ manifest }), expectedIdentity),
    ).rejects.toThrow('missing required capability "internetClient"');
  });

  it("rejects a package containing a non-x64 executable", async () => {
    const zip = new JSZip();
    zip.file(
      "AppxManifest.xml",
      renderStoreManifest({
        ...expectedIdentity,
      }),
    );
    zip.file("AppxBlockMap.xml", "<BlockMap />");
    const pe = x64Pe();
    pe.writeUInt16LE(0x014c, 0x44);
    zip.file("LabTrax.exe", pe);
    zip.file("resources/app.asar", "electron payload");
    zip.file("Assets/StoreLogo.png", minimalPng(50, 50));
    zip.file("Assets/Square44x44Logo.png", minimalPng(44, 44));
    zip.file("Assets/Square150x150Logo.png", minimalPng(150, 150));
    zip.file("Assets/Wide310x150Logo.png", minimalPng(310, 150));
    await expect(
      validateMsixBuffer(await zip.generateAsync({ type: "nodebuffer" }), expectedIdentity),
    ).rejects.toThrow("not an x64 executable");
  });

  it("requires exact Partner Center identity fields instead of inventing values", () => {
    expect(() =>
      validateStoreIdentity({
        identityName: "",
        publisher: "",
        publisherDisplayName: "",
      }),
    ).toThrow("STORE_PACKAGE_IDENTITY_NAME, STORE_PACKAGE_PUBLISHER");
  });

  it("constructs a four-part package version and rejects prereleases or overflow", () => {
    expect(parseStoreVersion("1.0.6", 143)).toBe("1.0.6.143");
    expect(() => parseStoreVersion("1.0.6-rc.1", 143)).toThrow("stable numeric x.y.z");
    expect(() => parseStoreVersion("1.0.6", 65536)).toThrow("0 to 65535");
  });
});
