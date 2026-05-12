# Phase 286 — high-rate cursor-vanishing diagnostic

**Date:** 2026-05-12
**Version:** v0.5.226 (diagnostic only)
**Status:** Diagnostic complete. The original "cursor vanishes" hypothesis was wrong; the real failure is widget false-positives in both detectors.

## What we tested

`test-phase286-high-rate-vanishing.ts`: drift cursor from far-right home (~1180, 805) toward Books target (757, 832) via 40 small chunks of -25 mickeys X / +6.25 mickeys Y. Between each chunk: take screenshot, run shape-detect (unhinted) AND NCC against the bundled templates (with a generous 200 px locality hint that follows the previous detection). Log every frame with positions and scores.

Frame set: `data/phase286-high-rate-vanishing/2026-05-12_06-11-58/` — 61 frames over ~3 minutes.

## What we found

**The cursor does NOT vanish.** Visual inspection of f0005 and f0014 confirms the cursor is plainly visible mid-screen during the move. The Phase 280 "cursor vanishes" framing was a misreading — what was actually happening is detector lies.

### Shape-detect behaviour

| Behaviour | Frames | Score range | Reported position |
|---|---|---|---|
| **Locked on clock widget (FP)** | most frames | 2.0-2.5 | (629, 155) or (618, 261) |
| **Found the real cursor** | f0007, f0014 | **5.0-5.3** | (934, 808), (806, 839) — within ~20 px of visually-confirmed cursor |

There's a **clean score separation**: clock-widget FPs plateau at score 2.5; real-cursor detections in this run scored 5+. But Phase 280 had real cursor detections at score 2.9 (over icon-adjacent wallpaper), so the gap isn't always this wide.

### NCC behaviour

NCC locked at **(936, 766) score 0.876** for ~95% of the run. That's the Settings-icon vicinity wallpaper. The reason: my Phase 283 templates were extracted from frames where the cursor was over wallpaper *near* the Settings icon. Those templates carry the Settings-area wallpaper context, and NCC matches that wallpaper anywhere on screen, beating the actual cursor signal.

NCC found the cursor correctly at f0007 with position (680, 962) score 0.836 — but the unhinted top match was the (936, 766) FP. The hint-following logic in this diagnostic also got stuck once NCC locked onto the FP.

## Root cause (revised, vs Phase 280)

1. **Shape-detect's clock-widget FP** is real and persistent (already known, Phase 280)
2. **NCC's Settings-vicinity FP** is new — comes from Phase 283 templates being extracted from a single wallpaper context (cursor near Settings)
3. The cursor IS in the frame the whole time; the detectors are choosing FPs over it

## Two actionable fixes

### Fix 1: Diversify NCC templates

The Phase 283 templates were all extracted from frames where the cursor was near the TV/Settings/Books icons. Re-seed with cursor at several DIFFERENT positions (top-left of screen, middle of wallpaper, mid-right, mid-left, dock-row gap, etc) to give NCC a backdrop-diverse template set. Each template's wallpaper context becomes less dominant in the matching.

Effort: ~1-2h with a scripted multi-position seeder.

### Fix 2: Reject detections inside known iPad widget regions

Add a small "widget blacklist" — reject any detection (shape-detect OR NCC) whose centroid falls inside the iPad home-screen clock region (~480-770 X, 60-260 Y) or the weather widget (~580-820 X, 350-590 Y) or the calendar widget. This handles the FP at the detection layer regardless of score.

Effort: ~1-2h with the regions as a const map per target context.

Earlier in this session the user picked "stroke topology" over "widget blacklist" as the long-term direction. Diversifying templates (Fix 1) is closer to that spirit — it's not a hardcoded list, it's better training data. But Fix 2 ships faster.

## Why neither A1/A2/A3 helped

The earlier candidate fixes (keepalive wiggle, bail-with-best-pass, mid-screen anchor) were all premised on the wrong root cause. The cursor isn't disappearing; the detectors are voting wrong. Wiggle can't fix bad detection; bail-to-earlier-pass can't fix it when ALL passes had detector lies; mid-screen anchor moves the cursor closer to dock-row FPs, not away from them.

## State at end of phase

- v0.5.226 unchanged (diagnostic only)
- 722/722 tests
- Diagnostic frame set saved: `data/phase286-high-rate-vanishing/2026-05-12_06-11-58/`
- Next action: choose Fix 1 (diverse templates) or Fix 2 (widget blacklist) and ship
