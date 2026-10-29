import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node", fileParallelism: false,
    include: ["src/lib/database-protection.test.ts", "src/lib/database-protection-onedrive.test.ts", "src/lib/database-protection-job.test.ts", "src/lib/production-content-protection.test.ts", "src/lib/production-content-capture.test.ts"],
  },
});
