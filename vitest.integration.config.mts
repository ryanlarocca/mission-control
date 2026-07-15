import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    include: ["tests/**/*.integration.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    // Real network calls to Supabase — one worker so the throwaway period's
    // lifecycle is deterministic, generous timeout for cold PostgREST.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
