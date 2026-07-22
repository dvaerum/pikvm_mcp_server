import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'bench-results'],
    // Under heavy PARALLEL load the default 5s per-test timeout trips spurious
    // "Test timed out" reds — import/transform starve when many test files run
    // at once on a loaded box (observed repeatedly; the same files pass green in
    // isolation). Serialize test FILES in CI only, for a deterministic signal;
    // `process.env.CI` is set by GitHub Actions (and most CI). Local dev keeps
    // file parallelism for speed. This resolves the config-vs-flag tradeoff:
    // it's config (no workflow scope needed) yet does NOT serialize local dev,
    // and any CI job that runs `vitest run` inherits the clean signal for free.
    fileParallelism: !process.env.CI,
  },
});
