import { defineConfig } from "vitest/config";

// Tests run against the pure logic in apps/api and apps/web/lib. Nothing here
// touches Postgres or Meta — suites that import a module with a DB dependency
// mock `@smm/db` themselves.
export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    // env.ts zod-parses process.env at import time, so anything importing it
    // needs these present. Values are fakes — no test connects to either.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
  },
});
