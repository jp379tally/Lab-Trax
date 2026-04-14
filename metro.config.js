const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const isNativeBuild =
  process.env.EXPO_PLATFORM === "ios" ||
  process.env.EXPO_PLATFORM === "android" ||
  process.env.EAS_BUILD_PLATFORM === "ios" ||
  process.env.EAS_BUILD_PLATFORM === "android";

if (isNativeBuild) {
  config.resolver = config.resolver || {};
  const existingBlockList = config.resolver.blockList
    ? Array.isArray(config.resolver.blockList)
      ? config.resolver.blockList
      : [config.resolver.blockList]
    : [];
  config.resolver.blockList = [
    ...existingBlockList,
    /node_modules\/pdfjs-dist\/.*/,
  ];
}

module.exports = config;
