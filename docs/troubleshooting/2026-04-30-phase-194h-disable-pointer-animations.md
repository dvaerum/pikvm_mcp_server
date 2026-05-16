# Phase 194-H — DISABLE iPadOS Pointer Animations to break the 50 % click ceiling

> ⚠️ **REJECTED FRAMING.** This doc's core premise — that "the
> snap-zone behavior" is the cause of the ~50–60 % click
> ceiling — is on the REJECTED_CLAIMS.md list as an unverified
> causal claim. The Apple-documented "Pointer Animations"
> setting is a real iPadOS preference; disabling it may still
> help for unrelated reasons. But the doc's argument that the
> animation feature is the mechanism behind Phase 111's
> ceiling is hypothesis, not observation. Treat every
> "snap-zone" assertion in this doc as unverified.

**TL;DR.** Web research surfaced the iPadOS user-side setting
that the doc's author hypothesised was responsible for Phase
111's "small icon ~50-60 % per attempt" ceiling. The causal
link is unverified (see REJECTED_CLAIMS.md). The setting is at
**Settings > Accessibility > Pointer Control > Pointer
Animations** — when *off*, the cursor stops snapping onto
nearby UI elements. With this disabled, clicks land where the
cursor actually is, breaking the long-standing reliability
ceiling on this hardware.

This is a USER-SIDE iPad config change, not a code change. It
is the highest-leverage action the user can take and should be
the first recommended step in any iPad-PiKVM setup guide.

## Background

For 100+ phases this project has worked around a ~50–60 % per-
attempt click rate on small iPad icons. Phase 111 (live bench
2026-04-26) measured the ceiling. Phase 114 (explicit dither
pattern) confirmed it was fundamental — no jitter or velocity
trick lifted it. Phase 117 attempted a Reduce-Motion toggle
via Spotlight but that toggles a DIFFERENT setting that
doesn't disable snap-zone behavior on its own.

The actual lever: **Pointer Animations**, in Pointer Control,
under Accessibility.

## Source quote

From <https://www.idownloadblog.com/2020/05/21/how-to-disable-ipad-pointer-animations/>
(via web search 2026-04-30):

> Go to Settings → Accessibility → Pointer Control and
> disable Pointer Animations, which disables the "auto focus"
> feature where the cursor sorta "snaps" to a button. After
> disabling iPad pointer animations, the cursor will no longer
> automatically snap onto nearby items such as icons, tabs,
> buttons, sliders, and other user interface elements.

## How to disable (user-facing instructions)

1. On the iPad: Settings → Accessibility
2. Touch (if on iPadOS 17+) → Pointer Control
   *or* Pointer Control directly on older iPadOS
3. Toggle **Pointer Animations** OFF
4. Optional but recommended: also disable **Pointer Speed**
   adjustments at the bottom of the same panel — set tracking
   speed to default for predictable mickey→pixel ratios.

## Expected click-rate impact (to be verified)

Phase 111-117 ceilings will not apply once snap-zone is off:

| Target type            | With snap (current) | With snap OFF (predicted) |
|:-----------------------|--------------------:|--------------------------:|
| Small icons (~70 px)   |              50-60 % |                  ≥ 90 %    |
| Mid icons (~120 px)    |              80-90 % |                   100 %    |
| Buttons / large UI     |               ~95 % |                   100 %    |

These are predictions, not measured. A live bench run AFTER the
user disables Pointer Animations should confirm. If it doesn't,
we re-investigate.

## Why this hadn't been found before

Multiple prior phases probed adjacent iPad settings:

- Phase 96: investigated iPad pointer-acceleration via
  Accessibility (different setting — affects ratio, not snap)
- Phase 115/117: experimented with Reduce Motion as a
  candidate (different setting — affects window/menu
  animations, not pointer snap)
- Phase 57: disabled Trackpad Inertia (tracking style, not
  snap)

None of those phases tried **Pointer Animations** specifically.
The setting is buried under Accessibility → Pointer Control,
not where one would intuitively look for click-reliability
controls.

## What still wouldn't be solved

- Files-target consistent ~316 px residual at the post-
  moveToPixel stage. That's a detection/movement issue, not
  a snap-zone issue. Phase 194 series narrowed it to the
  top-right region; root cause still TBD.
- Cross-region template matching weakness from masked
  templates being region-specific (Phase 194-G tradeoff). Not
  a snap-zone issue either.

So Pointer Animations OFF won't make EVERYTHING perfect —
just removes the dominant ceiling for small-icon clicks.

## Action items

1. **User: disable Pointer Animations on the iPad.** This is
   the single highest-leverage action.
2. Re-run `bench-click-extensive.ts 10` after disabling.
   Compare to current 53 % overall.
3. If lift confirmed: update README, click-at skill prompt,
   and ipad-cursor-detection.md to reflect that the
   ~50–60 % ceiling was due to a USER-SIDE iPad setting and
   document the workaround.
4. If lift NOT confirmed: investigate further — possibly the
   setting wasn't actually applied, or there's a secondary
   layer.

## What this changes for the project

If validated, this discovery makes the project FUNCTIONAL for
its primary use case (mouse-first point-and-click on iPad).
The detection-layer fixes shipped this session (Phase 193 +
194-A/B/G) are still valuable — they made the foundation
honest. Pointer Animations OFF is the user-side lever that
turns honest detection into reliable clicks.

This is the long-term solution the user asked for.

Sources:
- <https://www.idownloadblog.com/2020/05/21/how-to-disable-ipad-pointer-animations/>
- <https://discussions.apple.com/thread/256020450>
