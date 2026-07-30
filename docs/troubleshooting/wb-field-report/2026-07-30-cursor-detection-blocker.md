# PiKVM field report — 2026-07-30: cursor-detection is a hard blocker (HID is fine)

**For the pikvm_mcp_server team — second-look report.** The M0/M5/M6 fixes from
the first report shipped and mostly work (see "What's working"). But this
session hit a *different, worse* failure that stops all clicking: **the HID is
healthy, yet the cursor cannot be localized, so `pikvm_mouse_click_at` refuses to
fire.** Every workaround (seed, force-override, capture-during, recovery ladder)
also failed. This blocked an on-device Stripe payment test entirely.

- **Rig:** `pikvm01.bb.vcamp.dk` (SSH `root@`) → physical iPad (iPadOS 26.x), USB-OTG HID + HDMI. UDC `fe980000.usb`.
- **App under test:** WashingBrothers Kiosk (`dk.vammencamping.sumuppayment`), "Kiosk 1".
- **Impact:** couldn't tap ANY on-screen target remotely for ~45 min. Operator moved the mouse *manually via the pikvm web UI and it worked instantly* — so this is the MCP/detection layer, not the hardware.

---

## TL;DR (the core contradiction)

**HID works. Cursor localization does not. The two health checks disagree, so the
tool blocks clicks that would actually land.**

- `pikvm_hid_recover` → `R1 (soft-reset): RECOVERED — mouse emit moved the cursor (screen changed) — HID working → RECOVERED (behavioral verify healthy).`
- Immediately after, same target: `pikvm_mouse_click_at` → `V8 start detection failed (no cursor found, even after faded-cursor wake). Click NOT performed: the cursor position could not be verified.`

So `hid_recover`'s verify (screen changed on move) says healthy, while
`click_at`'s ML localization says "no cursor." **A move that changes the screen
proves the cursor rendered — but the detector still can't find it.** The operator
moving the mouse by hand (cursor visible, input landing) is the ground truth:
**input + rendering both work; only detection is broken.**

---

## Evidence (verbatim tool output, this session)

1. **`click_at` — consistent hard fail (6+ times in a row), big and small targets:**
   ```
   curve-one-shot: V8 start detection failed (no cursor found, even after faded-cursor wake)
   Click NOT performed: the cursor position could not be verified (the pointer is likely faded/off-screen),
   so no left click was sent. Wake the cursor first (a small pikvm_mouse_move) or retry once the screen is active.
   ```
   Earlier in the SAME session `click_at` worked fine (`landed 5–13px … after faded-cursor wake`, PIN entry + alert dismissal). It degraded mid-session with no clear trigger and never recovered.

2. **`seed_cursor_template` — can't find the cursor to build a template** (tried emit 80/80, 220/160, ±): 
   ```
   no cursor-sized motion-diff clusters detected (15-120 px). Cursor may be off-screen, dim, faded, or already at the wake-emit destination.
   ```
   So the seed can't recover the situation — the exact thing you'd reach for when the template goes stale.

3. **`pikvm_mouse_move` with `capture:["during"]`** (the frame "where the cursor is
   *guaranteed* rendered") — **rendered no visible cursor.** The M8 during-capture,
   designed to defeat the fade, showed a bare screen. Move succeeded
   (`Moved mouse by (40, 40)`), cursor not in the frame.

4. **`requireVerifiedCursor:false` does NOT force a click.** With
   `strategy:"assume-at"`, `requireVerifiedCursor:false`, `minBrightness:0`:
   ```
   Open-loop emitted 330X+459Y mickeys … Final position not detected — click accuracy uncertain.
   Click NOT performed: the cursor position could not be verified …
   ```
   The documented override to bypass verification did not bypass it — the click was still suppressed.

5. **`pikvm_usb_reconnect` (M0) — host rungs not wired on THIS box:**
   ```
   soft_connect unavailable: the host recovery trigger is not configured (pikvm-nixos must provide it …)
   udc-rebind unavailable: the host recovery trigger is not configured …
   All allowed remote rungs failed. Physical intervention required …
   ```
   The shipped M0 tool can't do anything here because `PIKVM_HID_RECOVERY_URL` isn't configured on pikvm01.

6. **UDC `state` node is a LYING signal.** Manual `cat /sys/class/udc/fe980000.usb/state`
   read `not attached` — and I (wrongly) told the operator the HID was dead. He
   then moved the mouse by hand and it worked. **`state=not attached` does NOT
   mean HID is down.** (The first report and the tools treat `state=configured` as
   the reliable HID-up signal; this session shows the inverse reading is
   unreliable too.)

7. **Manual soft_connect / UDC-rebind are inconsistent** — same commands flipped
   `state` to `configured` on some attempts and stayed `not attached` on others,
   with no correlation to whether HID actually worked.

---

## What made it worse (possible contributing factors to investigate)

- **Operator + MCP driving the same HID simultaneously?** `click_at` landed cleanly
  early (operator not touching it), then failed after the operator moved the mouse
  via the web UI. If the web-UI HID session and the MCP/API HID path fight over
  the pointer, that could corrupt localization. **Is concurrent web-UI + API HID
  control safe, or does it need a lock / single-owner?**
- **Self-inflicted corner-parking.** To work around detection, I sent large
  `send_mouse_relative` deltas (±4000) to pin the cursor to screen corners. After
  that, seed/detect never recovered. Pinning to an off-screen/edge position may
  leave the cursor where the detector can't re-acquire it and small wakes can't
  pull it back into view.
- **Dimmed modals compound it.** iOS system alerts / the app's admin sheet dim the
  backdrop; detection (and the brightness gate) degrade further on the dim frame.

---

## What's working (M-items from the first report — credit where due)

- **M5 `pikvm_snapshot`** ✅ — snapshot-to-file (incl. `region` crop) used heavily
  all session; rock solid.
- **M6 `singleTap`** ✅ — WHEN detection works, singleTap entered a 4-digit PIN
  cleanly (one tap = one digit, no double-fire) and dismissed a modal. The fix is
  correct; it's just gated behind the now-broken detection.
- **M0 `pikvm_usb_reconnect`** — exists, but see Evidence #5: host trigger not
  configured on pikvm01, so it no-ops here.
- **`pikvm_hid_recover`** — its R1 soft-reset genuinely restored HID responsiveness
  (screen-change verify), but that didn't help clicking (detection still dead).

---

## Asks for the team (ranked)

1. **Make cursor localization robust — this is THE blocker.** When the ML/template
   detector can't find the cursor, everything downstream dies and there is no
   working fallback. Options: auto-reseed the template on repeated detection
   failure; a "wiggle-then-lock" acquisition (sustained small oscillation to force
   iPadOS to render + hold the pointer, then localize); or a calibrated open-loop
   mode that does NOT need per-click detection (pin to a clamped corner → measured
   px/mickey → move → tap, with an after-diff to confirm hit).
2. **Fix `requireVerifiedCursor:false` to actually fire the click** (Evidence #4).
   A true "I accept the risk, click at the predicted landing" escape hatch is what
   you need when detection is down; right now it still suppresses.
3. **Stop trusting UDC `state` and the hid flags as ground truth** (Evidence #1, #6).
   The only reliable check is behavioral (move → screen changed → cursor
   localizable). Surface "HID responsive but cursor NOT localizable" as a distinct,
   named state — that's the exact situation here and no current signal reports it.
4. **Wire `PIKVM_HID_RECOVERY_URL` on pikvm01** so `pikvm_usb_reconnect`'s host
   rungs work here (Evidence #5).
5. **Concurrency:** define/enforce single-owner HID control (web UI vs MCP/API), or
   document that they must not run at once.

## Reproduce
Drive the WashingBrothers Kiosk grid on the iPad, run a few `click_at` taps until
detection drops (often after a dimmed modal or after large corner-pinning moves),
then observe: `hid_recover` says healthy, `seed_cursor_template` finds nothing,
`capture:["during"]` shows no cursor, `click_at` refuses. Operator hand-moving the
mouse in the web UI works throughout.

---

## VERIFICATION by the pikvm_mcp_server team (2026-07-30, iPad rig, georgs-mac-mini)

**Verdict: every SYMPTOM above reproduced exactly — but the root cause is NOT the
detector. HID was DOWN. Two of the report's secondary findings are real bugs and
are being fixed; two of its conclusions are corrected below.**

### Reproduced verbatim
`click_at` → `V8 start detection failed (no cursor found, even after faded-cursor wake)`
6/6 on the real gear target; `seed_cursor_template` found no motion clusters;
`capture:["during"]` returned a bare screen. So the report's observations are accurate.

### Root cause: HID was down, so there was no cursor to find
The report's core inference — "HID works, only detection is broken" — did not hold
under test. Ground truth collected in this order:

| Probe | Result |
|---|---|
| 45 × max-magnitude relative emits, then cursor-alive capture | **no pointer rendered anywhere** |
| **Keyboard** `⌘-,` (the documented admin-pad shortcut, needs no pointer) | **no effect** — so input was dead on BOTH paths, not just the pointer |
| `pikvm_health_check` | `mouse=offline, keyboard=offline` |
| host `cat /sys/class/udc/fe980000.usb/state` | `not attached` |
| host R2 `soft_connect` disconnect→connect | `not attached` → **`configured`** |
| `click_at` immediately after | **detection OK 7/7**, then a clean DEFAULT run **4/4 landing @ 1.0px**, pad opens |

So `no cursor found` was **literally true**: no HID input was reaching the iPad, so
no pointer existed to detect. The ML/localization layer was reporting honestly and
needs no rescue in this failure mode. **Ask #1 ("make cursor localization robust")
is therefore NOT the fix for this incident** — the fix is HID recovery (below).

### Why the report believed HID was healthy — a real bug (being fixed)
`pikvm_hid_recover`'s R1 verify reported `RECOVERED — mouse emit moved the cursor
(screen changed)`. That verify accepts **any** screen change (a clock tick or an
app animation passes it), so it **false-positived while HID was dead**. Fix in
flight: verify by actual cursor **render/localization** after an emit, not a bare diff.

### Confirmed real bugs from the report
1. **Evidence #4 is correct, and worse than described.** `requireVerifiedCursor` no
   longer exists anywhere in `src/` — it was removed together with the retry loop
   (#34) — and the null-detection gate (`src/index.ts`, single-shot path) is
   **unconditional** on iPad. There is currently **no** way to force a click when
   detection fails, and the documented override is silently ignored. A explicit,
   loudly-flagged `force` escape hatch is being added (default stays truthful-skip).
2. **Evidence #5 is correct.** `PIKVM_HID_RECOVERY_URL` is **not configured on
   pikvm01**, so `pikvm_usb_reconnect` no-ops *and* M4's UDC-state ground truth is
   unavailable there (health falls back to the kvmd flags, which lie). **This is the
   incident's real fix** — with it wired, the operator could have recovered in ~6 s
   instead of losing 45 minutes. Routed to the pikvm-nixos workstream.

### Corrections to the report
3. **Evidence #6 ("`state=not attached` does NOT mean HID is down") — not
   reproduced.** In this test `not attached` corresponded **exactly** to dead mouse
   *and* dead keyboard, and flipping it to `configured` restored both immediately.
   Read together with the report's own Evidence #7 (state flapping), #6 is best
   explained as a **timing/flap artifact**, not a refutation of the UDC signal.
   Recommend we keep treating UDC `state` as the HID-attach ground truth.
4. **The ±4000 corner-pinning workaround is harmful — do NOT use it.** Reproducing
   it (40 × max-magnitude emits to a corner) drove the **iPad hot-corner**, opening
   Notification Center / the lock screen and knocking the kiosk app out of the
   foreground. It also parks the pointer where the in-place wake cannot help. Use a
   small relative nudge instead; never slam to a hard corner on iPad.

### What the fixes do and don't cover (honest scope)
- The `force` escape hatch would **not** have saved this incident — with HID dead,
  a forced click registers nothing. It restores a genuinely useful capability that
  #34 removed (detection fails while HID is up).
- **Wiring `PIKVM_HID_RECOVERY_URL` on pikvm01 is the fix for this incident.**
- A new distinct state is being surfaced — **"HID down"** vs **"HID up but cursor
  not localizable"** — because the report's 45 minutes were spent inside that exact
  ambiguity. The cheap discriminator is the keyboard probe: if `⌘-,` (or any key)
  has no effect either, it's HID, not the detector.

### Also confirmed working
`M5 pikvm_snapshot`, `M6 singleTap`, and (once HID was up) the M2 faded-cursor wake —
DEFAULT `click_at` landed 4/4 at 1.0 px from target with the pad opening each time.

### Addendum (2026-07-30, later): the kvmd HID flags lie in BOTH directions

Gating the follow-up fixes turned up a stronger version of P3 than either report
had. Measured on this rig, repeatedly:

| Signal | Reading |
|---|---|
| kvmd flags | `mouse=offline, keyboard=offline` — **both** |
| UDC kernel state | `configured` |
| Reality (behavioural) | **clicks land** — 3/4 and 4/4 in separate runs, PIN pad opening each time |

An earlier sample showed the mirror case: `mouse=online, keyboard=offline` held
for 30+ s while the gadget was `configured` and clicking worked 4/4.

So the flags under-report a *working* HID as well as over-reporting a dead one.
Consequences we adopted:

- **UDC kernel state is the authoritative HID up/down signal** — via the
  appliance's loopback endpoint, or via the SSH reader on a stock box. Only a
  UDC-backed verdict may issue a confident directive.
- **A flags-only verdict must be NON-DIRECTIVE.** With no UDC reader available,
  `pikvm_health_check` must hedge ("flags indicate possible HID-down… confirm
  behaviourally before reconnecting") rather than print "HID DOWN → run
  `pikvm_usb_reconnect`". A wrong remedial action is worse than no advice: it
  sends an operator to reconnect/reboot a session whose mouse is fine.
- Corollary for anyone reading a health report: **`keyboard=offline` alone means
  nothing.** Confirm with the UDC state, or behaviourally (does a click land?).

Note this cuts against Evidence #6 of the original report in the useful
direction: the UDC state was *right* in every case tonight; it was the kvmd flags
that were unreliable in both directions.

### Deployment status (read before relying on any of this)

The SSH recovery transport and the SSH UDC reader are both selected by
`PIKVM_HID_RECOVERY_SSH`. As of this writing that variable is **not** set in the
deployed wrapper (`modules/home/pikvm-mcp.nix` in the macos-nixos-setup repo
carries only `PIKVM_PROXY`), so on the production WB-kiosk MCP they are inert:
`pikvm_usb_reconnect` has no transport and the diagnosis falls back to the flags
described above. Persisting that variable is a machine-config change and is
user-gated — until it lands, HID recovery on this rig still needs a human SSH.
