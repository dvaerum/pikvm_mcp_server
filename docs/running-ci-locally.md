# Running CI locally

Reproduce the entire GitHub Actions gate (`.github/workflows/ci.yml`) on your
own machine — no GitHub Actions minutes required. Every command below was run
and verified on `main` (commit `1b900df`); the expected results are noted.

CI has two jobs: **`test`** (typecheck + unit tests) and **`nix-runtime-smoke`**
(nix build + a runtime dlopen check). Run the one(s) relevant to your change, or
all of them before opening a PR.

## Prerequisites

- **Node 22+** and npm. CI pins Node 22 (`actions/setup-node` `node-version: 22`);
  the repo's `engines` allows `>=18`. (Verified locally on Node 24.)
- **Nix with flakes enabled** — only for the `nix-runtime-smoke` job.
- No `/dev/kvm` / VM runner needed: this repo has no NixOS VM check (those live in
  the separate `pikvm-nixos` repo).

Install JS deps once (mirrors CI's `npm ci`):

```bash
npm ci
```

## Job `test` — typecheck + unit tests

```bash
# 1. Typecheck (CI: `npm run typecheck` → tsc --noEmit)
npm run typecheck

# 2. Unit tests — SERIALIZED (see why below)
npx vitest run --no-file-parallelism
```

Expected: typecheck exits 0 with no output; vitest reports **95 test files /
948 tests passed** (as of `1b900df` — use the count as a sanity check that the
whole suite actually ran).

### Why `--no-file-parallelism`

`vitest.config.ts` sets `fileParallelism: false` **only when the `CI` env var is
set**, so on GitHub Actions the suite already runs one file at a time for a
deterministic signal under runner load. Locally `CI` is unset, so `npx vitest
run` fans out across files in parallel — and a few **real-timer** tests flake
under that load (notably `move-to.verificationLag`, which waits on wall-clock
timeouts, plus the `http-server` / `tool-login` / `ipadGoHome` integration
tests). Passing `--no-file-parallelism` reproduces exactly what CI does, so a
green local run matches the CI signal. (Equivalently: `CI=1 npx vitest run`.)

## Job `nix-runtime-smoke` — build + dlopen check

```bash
# 1. Build the nix package (CI: adds --print-build-logs)
nix build .#pikvm-mcp-server --print-build-logs

# 2. Runtime smoke: --help must exit 0 with no dlopen error
./result/bin/pikvm-mcp-server --help
```

Expected: the build succeeds (`auto-patchelf: 0 dependencies could not be
satisfied`) and `--help` prints the usage banner and exits 0.

### Why this job exists

A green `nix build` is **build-only** and can mask a run-broken package:
`onnxruntime-node` is a *static* import (`src/pikvm/cursor-ml-detect.ts`), so its
native `.so` is `dlopen`ed at module load — even `--help` triggers it. A
mislinked ORT library surfaces here as `ERR_DLOPEN_FAILED` at startup, invisible
to `nix build` and to the macOS npm-bundled path. Treat a non-zero exit or any
`ERR_DLOPEN_FAILED` / `onnxruntime … dlopen` in the output as a failure.

## All jobs, one shot

```bash
npm ci \
  && npm run typecheck \
  && npx vitest run --no-file-parallelism \
  && nix build .#pikvm-mcp-server --print-build-logs \
  && ./result/bin/pikvm-mcp-server --help
```

If every command exits 0, the branch would pass CI.
