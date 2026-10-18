import JSZip from "jszip";

const REQUIRED_CAPABILITIES = ["internetClient", "runFullTrust"];
const REQUIRED_ASSETS = {
  "Assets/StoreLogo.png": [50, 50],
  "Assets/Square44x44Logo.png": [44, 44],
  "Assets/Square150x150Logo.png": [150, 150],
  "Assets/Wide310x150Logo.png": [310, 150],
};

function decodeXmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(element) {
  return Object.fromEntries(
    [...element.matchAll(/([A-Za-z][\w:.-]*)="([^"]*)"/g)].map((match) => [
      match[1],
      decodeXmlAttribute(match[2]),
    ]),
  );
}

function getPngSize(buffer, name) {
  if (
    buffer.length < 24 ||
    buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  ) {
    throw new Error(`${name} is not a valid PNG image.`);
  }
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function assertPeIsX64(buffer) {
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("LabTrax.exe is not a valid Windows PE executable.");
  }
  const peHeaderOffset = buffer.readUInt32LE(0x3c);
  if (
    peHeaderOffset + 6 > buffer.length ||
    buffer.toString("ascii", peHeaderOffset, peHeaderOffset + 4) !== "PE\u0000\u0000"
  ) {
    throw new Error("LabTrax.exe is missing its Windows PE header.");
  }
  if (buffer.readUInt16LE(peHeaderOffset + 4) !== 0x8664) {
    throw new Error("LabTrax.exe is not an x64 executable.");
  }
}

export async function validateMsixBuffer(buffer, expected) {
  const zip = await JSZip.loadAsync(buffer);
  const manifestFile = zip.file("AppxManifest.xml");
  if (!manifestFile) {
    throw new Error("The MSIX package is missing AppxManifest.xml.");
  }
  const manifest = await manifestFile.async("string");
  const identityMatch = manifest.match(/<Identity\b([^>]*)\/?>/);
  if (!identityMatch) {
    throw new Error("AppxManifest.xml is missing the package Identity.");
  }
  const identity = attributes(identityMatch[1]);
  for (const [key, value] of Object.entries({
    Name: expected.identityName,
    Publisher: expected.publisher,
    Version: expected.version,
    ProcessorArchitecture: "x64",
  })) {
    if (identity[key] !== value) {
      throw new Error(
        `MSIX package identity ${key} is "${identity[key] ?? "(missing)"}"; expected "${value}".`,
      );
    }
  }

  const propertiesMatch = manifest.match(/<Properties\b[^>]*>([\s\S]*?)<\/Properties>/);
  const publisherDisplayName = propertiesMatch?.[1].match(
    /<PublisherDisplayName>([\s\S]*?)<\/PublisherDisplayName>/,
  )?.[1];
  const decodedPublisherDisplayName =
    publisherDisplayName === undefined ? undefined : decodeXmlAttribute(publisherDisplayName);
  if (decodedPublisherDisplayName !== expected.publisherDisplayName) {
    throw new Error(
      `MSIX publisher display name is "${decodedPublisherDisplayName ?? "(missing)"}"; ` +
        `expected "${expected.publisherDisplayName}".`,
    );
  }

  const capabilities = [
    ...manifest.matchAll(/<(?:[\w.-]+:)?Capability\b([^>]*)\/?>/g),
  ].map((match) => attributes(match[1]).Name);
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!capabilities.includes(capability)) {
      throw new Error(`MSIX package is missing required capability "${capability}".`);
    }
  }

  const appMatch = manifest.match(/<Application\b([^>]*)>/);
  if (!appMatch || attributes(appMatch[1]).Executable !== "LabTrax.exe") {
    throw new Error('MSIX package must start "LabTrax.exe" as its application executable.');
  }
  const entryPoint = attributes(appMatch[1]).EntryPoint;
  if (entryPoint !== "Windows.FullTrustApplication") {
    throw new Error("MSIX application entry point must be Windows.FullTrustApplication.");
  }

  const executableFile = zip.file("LabTrax.exe");
  if (!executableFile) {
    throw new Error("The MSIX package does not contain LabTrax.exe at its root.");
  }
  assertPeIsX64(await executableFile.async("nodebuffer"));

  if (!zip.file("resources/app.asar")) {
    throw new Error("The MSIX package is missing the packaged Electron application.");
  }
  if (!zip.file("AppxBlockMap.xml")) {
    throw new Error("The MSIX package is missing AppxBlockMap.xml.");
  }
  if (zip.file("AppxSignature.p7x")) {
    throw new Error(
      "The Store submission package must be unsigned; Microsoft signs MSIX packages after certification.",
    );
  }

  for (const [assetPath, expectedSize] of Object.entries(REQUIRED_ASSETS)) {
    const asset = zip.file(assetPath);
    if (!asset) throw new Error(`The MSIX package is missing ${assetPath}.`);
    const actualSize = getPngSize(await asset.async("nodebuffer"), assetPath);
    if (actualSize[0] !== expectedSize[0] || actualSize[1] !== expectedSize[1]) {
      throw new Error(
        `${assetPath} is ${actualSize.join("x")}; expected ${expectedSize.join("x")}.`,
      );
    }
  }

  return {
    identityName: identity.Name,
    publisher: identity.Publisher,
    version: identity.Version,
    architecture: identity.ProcessorArchitecture,
    capabilities: REQUIRED_CAPABILITIES,
    signature: "unsigned-for-microsoft-store-signing",
  };
}

export function parseStoreVersion(version, buildNumber) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Microsoft Store packaging requires a stable numeric x.y.z app version; received "${version}".`,
    );
  }
  const parts = version.split(".").map(Number);
  const build = Number(buildNumber);
  if (
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535) ||
    !Number.isInteger(build) ||
    build < 0 ||
    build > 65535
  ) {
    throw new Error(
      "Microsoft Store package versions require four numeric components from 0 to 65535.",
    );
  }
  return [...parts, build].join(".");
}

export function validateStoreIdentity({ identityName, publisher, publisherDisplayName }) {
  const missing = [];
  if (!identityName?.trim()) missing.push("STORE_PACKAGE_IDENTITY_NAME");
  if (!publisher?.trim()) missing.push("STORE_PACKAGE_PUBLISHER");
  if (!publisherDisplayName?.trim()) missing.push("STORE_PACKAGE_PUBLISHER_DISPLAY_NAME");
  if (missing.length) {
    throw new Error(
      `Microsoft Store packaging needs the exact Partner Center values for: ${missing.join(", ")}. ` +
        "Set these as GitHub Actions repository variables before enabling the Store package.",
    );
  }
  if (identityName.length > 50 || !/^[A-Za-z0-9.]+$/.test(identityName)) {
    throw new Error(
      "STORE_PACKAGE_IDENTITY_NAME must be the Partner Center identity name using only letters, numbers, and periods (maximum 50 characters).",
    );
  }
  if (!/^CN=.+/i.test(publisher)) {
    throw new Error(
      'STORE_PACKAGE_PUBLISHER must be the exact Partner Center publisher distinguished name, including its "CN=" prefix.',
    );
  }
  return {
    identityName: identityName.trim(),
    publisher: publisher.trim(),
    publisherDisplayName: publisherDisplayName.trim(),
  };
}

export function renderStoreManifest({
  identityName,
  publisher,
  publisherDisplayName,
  version,
}) {
  const xml = (value) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll("'", "&apos;");
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(identityName)}" Publisher="${xml(publisher)}" Version="${xml(version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>LabTrax</DisplayName>
    <PublisherDisplayName>${xml(publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="LabTrax" Executable="LabTrax.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="LabTrax" Description="LabTrax Desktop" BackgroundColor="transparent"
                          Square150x150Logo="Assets\\Square150x150Logo.png"
                          Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}
