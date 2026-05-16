# Phase 201 (v0.5.195) — bench HIT classification is broken; ALL recent click rates are inflated

**Date:** 2026-05-10  
**No code changes shipped** — this is an investigation note that
invalidates earlier bench measurements.

## What I tried

After ballistics file was found stale (April 26, resolution
1920×1080 vs current 1680×1050), ran fresh
`pikvm_measure_ballistics`. New profile written and copied to
`./data/ballistics.json`. Re-ran `bench-click-production.ts 5`.

Reported numbers:

| Target              | HIT | SKIP | MISS |
|:--------------------|:---:|:----:|:----:|
| Settings            | 3/5 | 1/5  | 1/5  |
| Books               | 4/5 | 0/5  | 1/5  |
| AppStore            | 0/5 | 5/5  | 0/5  |
| Files               | 1/5 | 4/5  | 0/5  |
| **TOTAL**           | 8/20 (40%) | 10/20 | 2/20 |

I claimed "60-80% Settings/Books — fresh ballistics is a 10x
improvement". That claim was WRONG.

## Visual verification reveals the bench is lying

Inspected post-click screenshots for the "HITs":

- **Settings trial 3 (HIT)**: home screen visible, Settings NOT
  opened. Cursor visible in dock area. The verifier triggered
  on cursor passing through the 100×100 verification region
  during the move sequence.
- **Settings trial 4 (HIT)**: home screen visible, Settings
  NOT opened. Same false-positive class.
- **Books trial 1 (HIT)**: home screen visible, Books NOT
  opened. Same false-positive class.
- **Files trial 4 (HIT)**: Weather app opened (clicked the
  Weather widget at top-left instead of Files at top-right).
  Wrong-element click counted as Files HIT because Weather's
  full-screen change crosses the Files target region too.

## Root cause

The bench's "HIT" criterion is `r.success` from
`clickAtWithRetry`, which is `verifyClick.screenChanged === true`.
The screen-changed check is "did ≥5% of pixels in the verification
region change between pre-click and post-click frames".

False-positive paths to "HIT":
1. **Cursor enters/leaves the verification region between pre-
   and post-click captures** — even with no app actually
   opening. Triggers >5% pixel change locally.
2. **Wrong app opens** — any full-screen app change crosses every
   point on the screen including the target region.
3. **Animated badges** (e.g., Settings' "1" notification dot
   pulsing) within the region.
4. **Widget animations** (Weather pin moving, Calendar dot
   highlight cycling) within the region.

The 5% threshold on a 100×100 region can be triggered by
~500 changed pixels. A cursor sprite is ~24×24 = 576 pixels —
so cursor entering or leaving the region alone can cross the
threshold.

## What this invalidates

Every "HIT" rate I measured this session — including the
n=10 "38%" baseline, the n=5 "60%" earlier, the n=5 "60% Settings
+ 80% Books" with fresh ballistics — was inflated by these
false positives. The earlier Phase 119 finding ("Phase 107 100%
verification was false-positive on wallpaper") was the same bug
class, and it has come back via a different path.

## What's actually happening

The TRUE correct-element click rate on ~70 px iPad icons is
likely very close to 0% with iPadOS Pointer Animations ON. The
prior framing — "Cursor positioning fundamentally cannot land
within the icon's hit-area when the snap-zone effect is
misaligning every emit" — asserts an unverified causal
mechanism. See REJECTED_CLAIMS.md. The observation (very low
correct-element rate) is supported by data; the "snap-zone
effect" cause is hypothesis only.

The Pointer Animations OFF user-side toggle (Phase 194-H) was
hypothesised to be the path to ≥ 90% on small icons; that
hypothesis rests on the same unverified "snap-zone" claim. No
amount of algorithmic tweaking has materially helped, and
several attempts (Phase 197b among others) actively regressed.

## What a proper "correct-element HIT" check would look like

To honestly measure correct-element clicks, the bench would need
a SEMANTIC post-click check — e.g.:

- Did the iPad's foreground app change from "home screen" to
  "Settings sidebar"? (Template-match against expected post-click
  app fingerprints.)
- Or: was the click position INSIDE the icon's hit-area?
  (Simpler — geometric check.)
- Or: image-classify the post-click screenshot against a known set
  of "expected" outcomes per target.

This is non-trivial. Cheap proxy: assert the post-click screenshot
NO LONGER matches the home-screen fingerprint. That at least
rejects "screen unchanged" cases. Doesn't catch "wrong app opened"
but is better than the current 5%-pixels-in-region check.

## What's not changing in this commit

- No code modified. The bench still uses the broken HIT criterion.
- The ballistics file IS updated (stale → fresh) — that's a real
  correctness improvement even if it didn't move the click rate.

## Conclusion

The published documentation now correctly says ~5-15% correct-
element rate (Phase 199 doc + README revision). Even THAT may be
optimistic — the real number could be closer to 0% pre-toggle.
The system's safety gate (maxResidualPx=35) does its job:
prevents wrong-element clicks from going silent. The iPadOS
Pointer Animations toggle remains the only known unblocker.

I'm stopping algorithmic iteration on small-icon click accuracy
in favor of honest documentation. Further work should:
1. Wait for the user to toggle Pointer Animations OFF and re-bench
2. OR build a semantic-verifier bench that can produce trustworthy
   numbers for further A/B testing

## Files updated

- `data/ballistics.json` — refreshed via
  `pikvm_measure_ballistics` (gitignored, not committed)
- `data/ballistics.json.backup-2026-04-26` — preserved old
  profile in case a rollback is needed (gitignored)
