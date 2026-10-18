"use strict";

function shouldUseAutoUpdater({ isDev, isWindowsStore, skipAutoUpdater }) {
  return !isDev && !isWindowsStore && !skipAutoUpdater;
}

module.exports = { shouldUseAutoUpdater };
