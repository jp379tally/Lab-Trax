const { getDefaultConfig } = require("expo/metro-config");
const { createProxyMiddleware } = require("http-proxy-middleware");
const path = require("path");

const config = getDefaultConfig(__dirname);

const localDir = path.resolve(__dirname, ".local").replace(/[/\\]/g, "[/\\\\]");
const existingBlockList = config.resolver?.blockList;
const newBlock = new RegExp(localDir + ".*");

if (existingBlockList) {
  if (Array.isArray(existingBlockList)) {
    config.resolver.blockList = [...existingBlockList, newBlock];
  } else {
    config.resolver.blockList = [existingBlockList, newBlock];
  }
} else {
  config.resolver = {
    ...config.resolver,
    blockList: [newBlock],
  };
}

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    return (req, res, next) => {
      if (req.url && req.url.startsWith("/api")) {
        return createProxyMiddleware({
          target: "http://localhost:5000",
          changeOrigin: true,
        })(req, res, next);
      }
      return middleware(req, res, next);
    };
  },
};

module.exports = config;
