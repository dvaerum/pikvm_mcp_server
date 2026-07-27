# iPadCollector — sign, install & launch from the terminal

Terminal-first runbook for (re-)signing the **iPadCollector** app and deploying it to
the kiosk iPad. No Xcode GUI required — but see the **hard rule** below about which
shell you run it from.

Written 2026-07-27 after the app's dev provisioning lapsed ("iPadCollector Is No
Longer Available") and blocked the PiKVM ground-truth workflow.

---

## TL;DR — the four commands

Run these **in your own Terminal.app / iTerm** (see the hard rule):

```bash
cd ~/pikvm_mcp_server/ipad-collector/iPadCollector

# 1. build + sign for the device
xcodebuild -project iPadCollector.xcodeproj -scheme iPadCollector -configuration Debug \
  -destination 'id=CF2B815D-7960-5B60-987B-FA2DC9A65353' \
  -allowProvisioningUpdates -derivedDataPath /tmp/ipadcollector-dd build

# 2. install to the iPad
xcrun devicectl device install app --device CF2B815D-7960-5B60-987B-FA2DC9A65353 \
  /tmp/ipadcollector-dd/Build/Products/Debug-iphoneos/iPadCollector.app

# 3. launch it (foreground, killing any old instance)
xcrun devicectl device process launch --terminate-existing \
  --device CF2B815D-7960-5B60-987B-FA2DC9A65353 com.bb.iPadCollector
```

Success looks like: `** BUILD SUCCEEDED **` → an install confirmation → a launch line
with a PID. The app then serves `getCursor` over **WebSocket on port 8767** (its role
as the PiKVM ground-truth source). **Verified working end-to-end 2026-07-27** — this
exact sequence built, installed, and launched.

**One-time keychain pre-auth** — if step 1 fails with `errSecInternalComponent`, or a
"codesign wants to sign using key…" dialog nags on every build, authorize the signing
key for the tools ONCE (enter your macOS login password at the prompt), then re-run
step 1:

```bash
security set-key-partition-list -S apple-tool:,apple: -s ~/Library/Keychains/login.keychain-db
```

(This kills the prompt for local GUI-Terminal builds. It does NOT enable headless/SSH
signing — that's a separate session-context limit; see the hard rule.)

---

## ⚠ HARD RULE — run it from a GUI login shell, NOT headless

`codesign` needs the interactive login keychain / SecurityAgent, which only exists in
your **Aqua (GUI) login session**. Run the build from **Terminal.app or iTerm on the
Mac itself**.

Do **NOT** run it from:
- a plain `ssh` session into the Mac,
- a background/automation/daemon/CI shell (this is why the Claude agent can't do it
  for you — it runs headless).

The symptom when you get this wrong:

```
.../iPadCollector.debug.dylib: errSecInternalComponent
Command CodeSign failed with a nonzero exit code
** BUILD FAILED **
```

`errSecInternalComponent` here = "no access to the signing key's keychain session",
i.e. wrong shell context. It is NOT a project/cert problem. Fix = run it from a local
GUI Terminal.

---

## When you need this

Re-run the four commands whenever the iPad app dies with any of:
- an iOS dialog **"'iPadCollector' Is No Longer Available"**,
- the app won't launch / `devicectl ... process launch` errors with `invalid code
  signature ... or profile has not been explicitly trusted`,
- the PiKVM ground-truth WS (port 8767 `getCursor`) is dead.

All of these = the development signature/provisioning **expired or was revoked**.
Free/personal Apple-ID dev builds lapse in ~7 days; re-signing (a rebuild) fixes it.

---

## Prerequisites (one-time)

- **Xcode** installed (provides `xcodebuild`, `codesign`, `xcrun devicectl`).
- An **Apple ID with a development team** added in Xcode → Settings → Accounts. This
  rig uses team **`988Y9UCZB7`** (Georg Sluyterman); identity **"Apple Development:
  Georg Sluyterman"**. `-allowProvisioningUpdates` uses it to auto-create/refresh the
  "iOS Team Provisioning Profile: com.bb.iPadCollector".
- iPad: **unlocked**, **trusted** ("Trust This Computer"), and **Developer Mode ON**
  (iPad → Settings → Privacy & Security → Developer Mode → on → reboot).
- If iOS shows an *untrusted developer*: iPad → Settings → General → **VPN & Device
  Management** → tap the developer profile → **Trust**.

---

## Reference facts for this rig

| Thing | Value |
|-------|-------|
| Xcode project | `~/pikvm_mcp_server/ipad-collector/iPadCollector/iPadCollector.xcodeproj` |
| Scheme / config | `iPadCollector` / `Debug` |
| Bundle id | `com.bb.iPadCollector` |
| Device name | "Georg's iPad" (iPad15,7 / iPad A16) |
| Device id (`devicectl`) | `CF2B815D-7960-5B60-987B-FA2DC9A65353` |
| Signing | Automatic · team `988Y9UCZB7` |
| Built .app path | `/tmp/ipadcollector-dd/Build/Products/Debug-iphoneos/iPadCollector.app` |
| WS port (getCursor) | `8767` |

**If the device id ever changes** (new iPad / re-pair), list devices and copy the new
identifier into the commands:

```bash
xcrun devicectl list devices
```

---

## Verify it's up

```bash
# app process is running:
xcrun devicectl device info processes --device CF2B815D-7960-5B60-987B-FA2DC9A65353 \
  | grep -i ipadcollector
```
Or just look at the iPad/PiKVM screen: the "No Longer Available" dialog is gone and the
collector is foreground. The PiKVM ground-truth benches (getCursor / onTapEvent on WS
8767) will then connect.

---

## Troubleshooting

- **`errSecInternalComponent` on CodeSign** → you're in a headless/SSH shell. Re-run in
  Terminal.app locally. (See the hard rule.)
- **A "codesign wants to sign using key …" prompt each build** → click **Always Allow**,
  or pre-authorize once so it stops prompting:
  ```bash
  security set-key-partition-list -S apple-tool:,apple: -s ~/Library/Keychains/login.keychain-db
  # (enter your macOS login password at the prompt)
  ```
  NOTE: this only removes the *prompt*; it does **not** enable headless/SSH signing (the
  session-context limit is separate).
- **Device not listed / "unavailable"** → unlock the iPad, re-plug USB, confirm Trust +
  Developer Mode.
- **Provisioning keeps expiring every few days** → expected on a free Apple ID; just
  re-run the four commands. For a longer-lived signature use a paid Apple Developer
  account team.
- **Clean rebuild** → `rm -rf /tmp/ipadcollector-dd` then re-run step 1.
- **Which cert/identity do I have?** → `security find-identity -v -p codesigning`.
