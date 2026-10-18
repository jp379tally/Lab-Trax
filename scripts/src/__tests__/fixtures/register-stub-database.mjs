/**
 * Preloaded with `--import` so the stub pool is in place before
 * `check-schema-columns.ts` imports `@workspace/db`.
 */

import { register } from "node:module";

register("./stub-database-hooks.mjs", import.meta.url);
