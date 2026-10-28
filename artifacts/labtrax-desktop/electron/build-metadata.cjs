const ALLOWED_UPDATE_CHANNELS = new Set(["installer", "manual", "portable"]);

function buildMetadataFromStamp(stamp, version) {
  const buildNumber =
    Number.isSafeInteger(stamp?.buildNumber) && stamp.buildNumber > 0
      ? stamp.buildNumber
      : null;
  const updateChannel = ALLOWED_UPDATE_CHANNELS.has(stamp?.updateChannel)
    ? stamp.updateChannel
    : null;

  return {
    version: typeof version === "string" && version.trim() ? version : null,
    buildNumber,
    updateChannel,
  };
}

module.exports = { buildMetadataFromStamp };
