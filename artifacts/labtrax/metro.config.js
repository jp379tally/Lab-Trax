const { getDefaultConfig } = require("expo/metro-config");
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

const serverOnlyBuiltins = new Set([
  "fs", "http", "https", "url", "stream",
  "net", "tls", "dns", "os", "child_process",
  "cluster", "readline", "repl", "vm",
  "worker_threads", "perf_hooks", "inspector",
  "crypto",
]);

const pdfjsDistDir = path
  .join(__dirname, "node_modules", "pdfjs-dist")
  .replace(/[/\\]/g, "[/\\\\]");

config.resolver = {
  ...config.resolver,
  blockList: combined,
  resolveRequest: (context, moduleName, platform) => {
    const isNative = platform === "ios" || platform === "android";
    if (isNative) {
      if (
        moduleName === "pdfjs-dist" ||
        moduleName.startsWith("pdfjs-dist/")
      ) {
        return { type: "empty" };
      }

      const originPath = context.originModulePath || "";
      const isFromPdfjs = new RegExp(pdfjsDistDir).test(originPath);
      if (isFromPdfjs) {
        return { type: "empty" };
      }

      if (serverOnlyBuiltins.has(moduleName)) {
        return { type: "empty" };
      }
      if (moduleName.startsWith("node:")) {
        const bare = moduleName.slice(5);
        if (serverOnlyBuiltins.has(bare)) {
          return { type: "empty" };
        }
      }
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = config;
