/**
 * Feature / tuning settings for the PiKVM MCP server.
 *
 * This is the single home for every OPTIONAL `PIKVM_*` flag that tunes cursor
 * detection, movement, and click behaviour — the knobs that used to be read
 * with scattered `process.env.PIKVM_*` lookups (many frozen at module-import
 * time) across cursor-ml-detect, move-to, click-verify, pointer-accel, and the
 * REST client. Centralising them here makes the whole tuning surface
 * discoverable from one interface and parsed in one place.
 *
 * Distinct from `config.ts`:
 *   - `config.ts` owns the CONNECTION config (host/password/…) and THROWS when a
 *     required value is missing — appropriate for "we can't talk to the device".
 *   - `settings.ts` owns OPTIONAL tuning flags and NEVER throws — a missing flag
 *     just falls back to its documented default.
 *
 * Behaviour note: unlike `config.ts`, this module deliberately does NOT load
 * `.env` (no dotenv). These flags have always been read straight from the real
 * process environment (set via the MCP launcher / systemd unit / shell), not
 * from `.env`, and several were captured at import time before dotenv could run.
 * Reading `process.env` verbatim here preserves that exact behaviour. Paths are
 * kept as their raw env strings — path resolution / fallback chains stay in the
 * modules that own that concern (e.g. the v12→v11→v9→v8 chain in
 * cursor-ml-detect).
 */

export interface Settings {
  /** ML cursor-detection knobs. */
  ml: {
    /** PIKVM_ML_MODEL — raw override path for the single-stage v1 model. */
    model?: string;
    /** PIKVM_ML_V5_MODEL — raw override path for the v5 presence model. */
    v5Model?: string;
    /** PIKVM_ML_V5_PRESENCE_GATE=1 — gate v1 behind the v5 presence head. */
    v5PresenceGate: boolean;
    /** PIKVM_ML_V8_MODEL — raw override path; suppresses the v12→v11→… chain. */
    v8Model?: string;
    /** PIKVM_ML_CASCADE — dual-head cascade tracker. DEFAULT ON (opt out with =0). */
    cascadeEnabled: boolean;
    /** PIKVM_ML_VERIFIER_MODEL — raw override path for the crop verifier. */
    verifierModel?: string;
    /** PIKVM_ML_GRID_STRIDE — native-px grid step for the cascade (default 48). */
    gridStride: number;
    /** PIKVM_ML_VERIFY_THRESH — verifier accept threshold (default 0.5). */
    verifyThresh: number;
    /** PIKVM_ML_CAPTURE_DIR — when set, dump detection crops here for labelling. */
    captureDir?: string;
    /** PIKVM_ML_DISABLE=1 — force the probe-and-diff path, skip ML entirely. */
    disabled: boolean;
  };

  /** Relative-mouse movement + click tuning. */
  movement: {
    /** PIKVM_USE_LEARNED_BALLISTICS=1 — use the learned pointer-accel model. */
    useLearnedBallistics: boolean;
    /** PIKVM_DISABLE_RETRY_SKIP_PROBE=1 — force a fresh probe on every retry. */
    disableRetrySkipProbe: boolean;
    /** PIKVM_PREDOWN_DIR — when set, dump pre-click-down screenshots here. */
    predownDir?: string;
    /** PIKVM_FORCE_WAKE=1 — always emit the wake wiggle before a click. */
    forceWake: boolean;
    /**
     * PIKVM_CLICK_MAX_RESIDUAL_PX — proximity-gate override, kept as the RAW
     * string. Its "off"/"0"/positive-number parsing and the per-mode default
     * live in `defaultMaxResidualPxFor` (click-verify), which needs the runtime
     * mouse-mode to decide the fallback.
     */
    clickMaxResidualPxRaw?: string;
  };

  /** PIKVM_POINTER_ACCEL_MODEL — raw override path for the pointer-accel ONNX. */
  pointerAccelModel?: string;
  /** PIKVM_EMIT_LOG — when set, append every relative emit to this file. */
  emitLog?: string;
}

/**
 * Parse a {@link Settings} from an environment map. Pure: reads only the passed
 * `env`, never throws, applies each flag's documented default. Injectable for
 * tests.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    ml: {
      model: env.PIKVM_ML_MODEL || undefined,
      v5Model: env.PIKVM_ML_V5_MODEL || undefined,
      v5PresenceGate: env.PIKVM_ML_V5_PRESENCE_GATE === '1',
      v8Model: env.PIKVM_ML_V8_MODEL || undefined,
      cascadeEnabled: env.PIKVM_ML_CASCADE !== '0',
      verifierModel: env.PIKVM_ML_VERIFIER_MODEL || undefined,
      gridStride: Number(env.PIKVM_ML_GRID_STRIDE ?? '48'),
      verifyThresh: Number(env.PIKVM_ML_VERIFY_THRESH ?? '0.5'),
      captureDir: env.PIKVM_ML_CAPTURE_DIR || undefined,
      disabled: env.PIKVM_ML_DISABLE === '1',
    },
    movement: {
      useLearnedBallistics: env.PIKVM_USE_LEARNED_BALLISTICS === '1',
      disableRetrySkipProbe: env.PIKVM_DISABLE_RETRY_SKIP_PROBE === '1',
      predownDir: env.PIKVM_PREDOWN_DIR || undefined,
      forceWake: env.PIKVM_FORCE_WAKE === '1',
      clickMaxResidualPxRaw: env.PIKVM_CLICK_MAX_RESIDUAL_PX,
    },
    pointerAccelModel: env.PIKVM_POINTER_ACCEL_MODEL || undefined,
    emitLog: env.PIKVM_EMIT_LOG || undefined,
  };
}

// Memoised process-wide singleton. Reads `process.env` on first access, matching
// the historical "read once at import" semantics of the consts this replaces.
let cached: Settings | null = null;

/** The process-wide settings, parsed once from `process.env`. */
export function getSettings(): Settings {
  if (cached === null) cached = loadSettings();
  return cached;
}

/** Test hook: drop the memoised singleton so the next getSettings() re-reads env. */
export function resetSettingsForTest(): void {
  cached = null;
}
