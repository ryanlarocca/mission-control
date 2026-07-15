import { defineConfig } from "vitest/config"
import path from "node:path"

// Unit tests: `npm test` (tests/*.unit.test.ts — pure, no network).
// Integration tests: `npm run test:integration` — hit the REAL LRG Supabase
// project through the actual route handlers, inside a throwaway board_period
// that is created in beforeAll and cascade-deleted in afterAll. They load
// credentials from .env.local (see tests/setup-env.ts) and are excluded from
// the default run so `npm test` stays offline-safe.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    include: ["tests/**/*.unit.test.ts"],
    environment: "node",
  },
})
