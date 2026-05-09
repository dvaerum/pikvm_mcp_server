# Phase 194-F (diagnostic) — template context bleed at inference time

**TL;DR.** The Files-target "200 px undershoot" diagnosed in
Phase 194-E is **not a real cursor displacement**. It's a
template-match FALSE POSITIVE. `maybePersistTemplate` in
`move-to.ts` extracts templates without a diff mask, so the
24×24 px template captures cursor pixels PLUS surrounding
wallpaper context. At match time, those wallpaper-context
templates score 0.94+ on **similar wallpaper regions**
elsewhere on screen, returning a fixed `(832, 408)` regardless
of where the cursor actually is.

The Phase 194-B fix that finally made templates persist live
on this iPad is now itself the source of the contamination:
once a template seeds during a Files-target trial, every
subsequent template-match returns the seed-time position.

## Disambiguating diagnostic — `bench-x-axis-sweep.ts`

This bench slams cursor toward top-left, then emits 60-mickey
rightward steps with cursor probing after each:

**Run 1 — with persisted templates (4 loaded):**
```
Initial post-slam: (832, 408) score=0.97
step 1 (60 mickeys total):  (832, 408) score=0.97
step 2 (120 mickeys total): (832, 408) score=0.97
step 3 (180 mickeys total): (832, 408) score=0.97
[plateau detection bailed]
```

The cursor probe returned the **same (832, 408) on three
consecutive frames** — but visual inspection of those frames
shows no cursor at (832, 408). The 0.97 NCC was a wallpaper
match, not a cursor match.

**Run 2 — with templates wiped (0 loaded):**
```
Initial post-slam: null
step 1: null  ... step 25 (1500 mickeys total): null
```

No template, no probe — **but** the final saved frame at step
25 (`data/x-sweep/25.jpg`) shows the cursor at the iPad's
top-right edge (~1170, 60). The cursor moved ~1170 px right
under 1500 cumulative mickeys.

**Conclusion:** mouse emits drive the cursor across the whole
iPad screen. The "stuck at (832, 408)" appearance was a
template-match illusion.

## Why the trace bench in Phase 194-E was misleading

`bench-click-trace.ts` Files trial 3 reported:

```
s2 moveToPixel: reported (832, 404) residual=204 px
                visible-template (832, 404) score=0.94
```

The "agreement" between motion-diff and template-match looked
like strong evidence the cursor was really there. Both were
wrong:

- **Motion-diff** at the end of `moveToPixel` reports the
  position of the LAST detected motion cluster, not necessarily
  the actual cursor's resting position. If the cursor moved
  beyond the search region or the algorithm picked up a
  badge/widget animation, the report is stale.
- **Template-match** scored against contaminated wallpaper-
  context templates returned the seed-time position.

Both components are now confirmed honest only WITH clean inputs.
With contaminated templates, both lie consistently — and they
appear to "agree" because they're both anchored to the same
wallpaper pattern.

## The structural fix (Phase 194-G candidate)

`maybePersistTemplate` (move-to.ts:586) calls
`extractCursorTemplateDecoded(screenshot, cursorPos, 24)` —
plain raw extraction, no mask. The cursor is ~7×11 px and
the template is 24×24 = 576 px. So **at most ~12 % of the
template is cursor pixels; the rest is wallpaper context**.
NCC against similar wallpaper elsewhere can score 0.9+ even
when the actual cursor is absent.

`seedCursorTemplate` (Phase 106) already solved this: it uses
`extractMaskedTemplate(decoded, pos, 24, diffMask)` which
zeroes out pixels that didn't change between the pre and post
frames. The result is a template with cursor pixels + zero
elsewhere — no wallpaper context to false-match.

**Phase 194-G fix:** thread the diff mask from the moveToPixel
detection step into `maybePersistTemplate`, then extract via
`extractMaskedTemplate` instead of `extractCursorTemplateDecoded`.
This removes wallpaper context from every template persisted
during normal click operation.

Implementation needs care:
- The caller in move-to.ts has access to the pre/post frames
  during the detect-then-move loop. Compute the diff mask
  there and pass it along.
- Existing tests for `maybePersistTemplate` use the unmasked
  signature; either widen the API or add a parallel masked
  path.
- A live verification bench should run AFTER the change to
  confirm:
  1. Templates persisted on Files trials don't lock template-
     match to a fixed (x, y) on subsequent frames
  2. AppStore/Files click rates recover from the Phase 194-D
     1/10 floor seen with contaminated templates active

## Phase 194-A (load-time validator) is necessary but not
sufficient

The `looksLikeCursor` validator runs at load time (Phase 194-A)
and at persist time. Both already filter templates that LOOK
like wallpaper-only crops. The contaminated templates we're
seeing here have a real cursor in the centre — they pass
`looksLikeCursor` legitimately. The wallpaper context is NOT
in the cursor's blob; it's the surrounding pixels that NCC
weighs heavily because they cover most of the template area.

The fix has to be at extraction time (zero out non-cursor
pixels), not at validation time.

## Visual reference

- `data/x-sweep/00-initial.jpg` — frame after slam-to-top-left.
  Template probe returned (832, 408) score 0.97. Visual
  inspection: no cursor at (832, 408); cursor visible at
  top-left corner (~515, 65) per the slam.
- `data/x-sweep/25.jpg` — frame after 1500 cumulative
  rightward mickeys. Cursor visible at top-right edge
  (~1170, 60). Demonstrates emits work; the "stuck cursor"
  was a probe illusion.

## Don't forget when picking up Phase 194-G

- Wipe `data/cursor-templates/` before any verification run;
  contaminated templates from this session are still cached.
- Also worth wiping during/after if templates re-seed
  contaminated.
- `bench-x-axis-sweep.ts` and `bench-click-trace.ts` are
  reusable diagnostics. Keep them.
