# iPad Collector — build, install, run

The Xcode project at `ipad-collector/iPadCollector/iPadCollector.xcodeproj`
is fully wired: `INFOPLIST_KEY_UIRequiresFullScreen`,
`INFOPLIST_KEY_UIStatusBarHidden`,
`INFOPLIST_KEY_NSLocalNetworkUsageDescription`, and the rest of the keys
are baked into `project.pbxproj`. Team `988Y9UCZB7` is preset. No Xcode
GUI clicking required.

## Build, install, launch (terminal-only)

> **Must run from a GUI (Aqua) session — a real Terminal.app window, NOT
> tmux / ssh / a background launchd context.** Codesigning needs the login
> keychain's signing key, which macOS only releases to the foreground GUI
> session. From a background session (`launchctl managername` prints
> `Background`) codesign fails with `errSecInternalComponent` and the keychain
> reports "User interaction is not allowed" — the app compiles but won't sign.
> (Same session-isolation as macOS Local Network privacy.)

Plug the iPad in via USB-C, unlock it, tap **Trust This Computer** if
prompted. Then:

```bash
cd /Users/georg/pikvm_mcp_server/ipad-collector/iPadCollector

# 1. Resolve the device identifier (run once; copy the UDID-looking string)
xcrun devicectl list devices

# 2. Build for the device (Release config, signed with team 988Y9UCZB7).
#    -allowProvisioningUpdates lets xcodebuild fetch/refresh the profile.
xcodebuild \
  -project iPadCollector.xcodeproj \
  -scheme iPadCollector \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build \
  -allowProvisioningUpdates \
  build

# 3. Install the resulting .app
xcrun devicectl device install app \
  --device <DEVICE_ID> \
  build/Build/Products/Release-iphoneos/iPadCollector.app

# 4. Launch it (bundle id is com.bb.iPadCollector)
xcrun devicectl device process launch \
  --device <DEVICE_ID> \
  com.bb.iPadCollector
```

First install only: the iPad will refuse to launch with "Untrusted
Developer". On the iPad, go to **Settings → General → VPN & Device
Management → <your Apple ID> → Trust**, then re-run step 4.

## Configure the WebSocket URL

The UI is intentionally invisible (no buttons, no chrome — that way it
doesn't pollute training screenshots). To open the settings sheet:

1. With a keyboard connected (PiKVM HID counts), type the literal
   letters `h`, `e`, `l`, `p`.
2. The settings sheet appears. Enter `ws://<mac-ip>:8767`.
3. Tap **Connect**, then **Done**.

The URL is persisted in `UserDefaults` and reused on every launch. The
app auto-connects within 3 s of launch and auto-reconnects every 1 s if
the WebSocket drops.

## Re-signing every 7 days (free Apple ID)

Free Apple ID provisioning profiles expire after 7 days. The app stops
launching; iPadOS shows "Unable to verify app". Fix:

```bash
cd /Users/georg/pikvm_mcp_server/ipad-collector/iPadCollector
xcodebuild -project iPadCollector.xcodeproj -scheme iPadCollector \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath build build
xcrun devicectl device install app --device <DEVICE_ID> \
  build/Build/Products/Release-iphoneos/iPadCollector.app
```

That re-issues the profile and replaces the installed binary in place.
URL and any cached settings survive (UserDefaults is preserved on
overwrite install).

Upgrade to a paid Apple Developer account ($99/yr) to get 1-year
profiles.
