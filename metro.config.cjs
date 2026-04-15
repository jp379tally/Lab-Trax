const { getDefaultConfig } = require("expo/metro-config");
const { createProxyMiddleware } = require("http-proxy-middleware");
const path = require("path");

const config = getDefaultConfig(__dirname);

const toPattern = (dir) =>
  new RegExp(
    path.resolve(__dirname, dir).replace(/[/\\]/g, "[/\\\\]") + ".*"
  );

const blockedDirs = [".local", "server", "shared"];
const newBlocks = blockedDirs.map(toPattern);

const existingBlockList = config.resolver?.blockList;

let combined;
if (!existingBlockList) {
  combined = newBlocks;
} else if (Array.isArray(existingBlockList)) {
  combined = [...existingBlockList, ...newBlocks];
} else {
  combined = [existingBlockList, ...newBlocks];
}

config.resolver = {
  ...config.resolver,
  blockList: combined,
  resolveRequest: (context, moduleName, platform) => {
    const isNative = platform === "ios" || platform === "android";
    if (isNative && moduleName === "pdfjs-dist") {
      return { type: "empty" };
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

const apiProxy = createProxyMiddleware({
  target: "http://localhost:5000",
  changeOrigin: true,
  timeout: 120000,
  proxyTimeout: 120000,
});

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    return (req, res, next) => {
      if (req.url && req.url.startsWith("/api")) {
        return apiProxy(req, res, next);
      }
      return middleware(req, res, next);
    };
  },
};

module.exports = config;
