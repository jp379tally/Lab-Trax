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
