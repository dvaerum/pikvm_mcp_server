# Phase 288 — masked-template re-seed (Phase 106 revisit): NO SHIP

**Date:** 2026-05-12
**Version:** v0.5.226 (no code change — templates revert to Phase 283 set)
**Status:** Attempted, measured, reverted.

## Hypothesis

Phase 287 established that NCC's high scores against the Phase 283 unmasked templates are dominated by **wallpaper-context** match, not cursor-pixel match — the 24×24 template is ~70% wallpaper around the cursor. Diversifying positions made wallpaper context worse on near target.

The user picked **Fix B: mask-based templates (Phase 106 revisit)** to break the wallpaper coupling at the data-extraction layer instead of the detector layer. The plan: re-seed using `seedCursorTemplate`, which internally calls `extractMaskedTemplate` (`seed-template.ts:250`). The mask is the motion-diff between before/after frames; non-cursor pixels get zeroed in the template, leaving cursor-only signal.

## What was tested

`test-phase288-masked-reseed.ts`: drove the cursor through 5 emit-relative positions across the screen. At each position, called `seedCursorTemplate` (60 px wake emit, 500 ms settle). `looksLikeCursor` accepted 3 of 5 candidates; the other 2 were rejected (extracted region didn't match cursor brightness profile).

3 masked templates persisted. Phase 283's 9 templates backed up to `data/cursor-templates.backup-pre-phase288/`.

## Static-frame verification (Phase 280 f023, cursor known at ~733,770)

```
Unhinted NCC (minScore=0):  (766, 658) score=0.675
Production NCC (minScore=0.83): null (sub-threshold)
Hinted NCC at (733,770)±100: (766, 658) score=0.675, dist=117 px
```

The masked templates score **0.675** on the static frame — below the production 0.83 threshold — and the top match position is still wrong (117 px from ground truth, same Settings-area wallpaper FP that Phase 287 documented).

Compare Phase 283b's unmasked extraction on the same frame: score 0.857, dist 6 px. The unmasked templates are objectively better at this static-frame test.

## Live click-rate measurements

| Target | Phase 283 (9 unmasked) | Phase 288 (3 masked) | Δ |
|---|---|---|---|
| Near (905, 800) | 50-70 % band | **50 % (N=20)** | bottom of band / −10–20 pp |
| Far (757, 832) | ~0 % | **0 % (N=20)** | unchanged |

Masked templates regressed near target by ~10-20 pp; far target stayed at zero.

## Why masked-NCC didn't work as hoped

The Phase 106 extraction is correct in spirit — zero out non-cursor pixels at extract time — but `correlateAt` (`cursor-detect.ts:819`) still iterates **all** 576 pixels of the 24×24 template region during matching. The math problem:

- ~80 cursor pixels with bright values
- ~496 background pixels with value 0

When this template is correlated against a real screen region:
- Cursor pixels contribute meaningful covariance (numerator)
- Zero pixels contribute noise (both numerator and denominator)
- Template's effective signal is diluted by 80/576 ≈ 14 % of the area

The denominator's σ_template is dominated by the huge run of zero pixels, which compresses the achievable correlation coefficient. Even a perfect cursor match scores ~0.67 instead of the >0.85 the unmasked extraction can reach on the same frame.

## Secondary issue: motion-diff seed captured a widget FP

Step 4.5 ('mid-bottom above dock' drift) ran `seedCursorTemplate` and got back `cursorPosition: (634, 132)` — that's the **clock widget**, not the cursor. The motion-diff caught clock-hand movement (the clock digit changed while we were drifting) and the cluster picker chose the larger/brighter widget motion over the cursor's smaller cluster. `looksLikeCursor` accepted because the clock-area pixels passed brightness gates. This means even masked extraction is **not robust to widget motion during the seed window**.

So Phase 288's 3 templates were 2 clean cursor extracts + 1 clock-widget FP. Bench would not have lifted even with mask-aware NCC.

## Action taken

Restored Phase 283 templates from `data/cursor-templates.backup-pre-phase288/`. Live bench post-restoration: near target 55% (back in the Phase 283 variance band).

The Phase 288 script (`test-phase288-masked-reseed.ts`) and backup directory are preserved.

## What this teaches

1. **Phase 106 was a half-fix.** `extractMaskedTemplate` zeros background at extract time, but `correlateAt` doesn't skip zero pixels at match time — so the masked template's score is mechanically compressed regardless of cursor quality.
2. **Real Phase 106 fix needs mask-aware NCC.** The `CursorTemplate` interface (`cursor-detect.ts:654`) needs an optional `mask: ReadonlyArray<boolean>` field; `computeTemplateStats` and `correlateAt` need to skip mask-false pixels in both numerator and denominator. That's a code change in three functions, plus a backwards-compatible template-set serialization decision. Effort: ~3-4 h.
3. **Motion-diff seeding is not widget-safe.** Even with masking, if a widget animates during the seed window, the captured "cursor template" is actually a widget template. Diverse-position seeding can't fix this — clock and weather animate constantly.
4. **Static-frame NCC score is a good predictor of bench outcome.** Phase 283b unmasked: 0.857 / 6 px → ~70 % near. Phase 287 diverse unmasked: 0.73 / unclear → 47.5 % near. Phase 288 masked: 0.675 / 117 px → 50 % near. The drop from 0.857 to 0.675 tracks the bench regression.

## Options for the next phase (informational, no auto-pivot)

Three paths the user could pick:

- **B+: mask-aware NCC.** Implement the missing half of Phase 106 — store mask alongside template; skip mask-false pixels in `correlateAt`. Theoretically lifts the masked-template score from ~0.67 to >0.85 on the same frame. Effort 3-4 h. Risk: bumps the template file format.
- **C: widget blacklist (Fix 2 from Phase 286).** Reject detections inside the clock / weather / calendar widget regions outright. Doesn't touch templates. Effort 1-2 h.
- **D: better seed gating.** Add a "widget-region exclusion" to `seedCursorTemplate` so a cluster falling inside known widget regions is rejected even if `looksLikeCursor` accepts the brightness profile. Less general than C but no detector changes.

Not pursued without user direction.

## State at end of phase

- v0.5.226 unchanged (template revert only)
- 722/722 tests
- Templates: restored to Phase 283 set (9 files)
- Near target: 50-70 % band
- Far target: ~0 %
- Phase 288 script + backup preserved
