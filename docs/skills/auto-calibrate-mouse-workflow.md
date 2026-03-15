# auto-calibrate-mouse-workflow

> MCP Prompt: `auto-calibrate-mouse-workflow`

Step-by-step procedure for automatic mouse calibration.

## Arguments

None.

## Workflow Steps

Automatic calibration detects the cursor by diffing screenshots and computes calibration factors without any manual coordinate estimation.

### Step 1 — Run Auto-Calibration

Call `pikvm_auto_calibrate`. The tool will:

1. Move the mouse to various positions across the screen
2. Take pairs of screenshots and diff them to detect cursor movement
3. Compute calibration factors from detected vs expected positions
4. Verify accuracy by checking the cursor lands within 20px of targets

This takes ~30-60 seconds depending on the number of rounds and connection speed.

### Step 2 — Check Result

The tool returns success/failure, calibration factors, and a confidence score.

- **Success**: Calibration is applied automatically. You can proceed to use mouse tools.
- **Failure**: The tool will suggest next steps. Common fixes:
  - Increase `moveDelayMs` (e.g., 500 or 800) for slow PiKVM connections
  - Ensure the cursor is visible (not hidden by the OS)
  - Ensure the desktop is static (close videos, stop animations)
  - Fall back to manual calibration with the `calibrate-mouse-workflow`

### Step 3 — Verify (Optional)

Move the mouse to a known UI element with `pikvm_mouse_click` and take a screenshot to confirm the click landed correctly.

## Notes

- Auto-calibration is the **preferred** method. Only use manual calibration as a fallback.
- Other PiKVM tools are blocked while calibration is running.
- If the remote screen resolution changes, you'll need to recalibrate.
- Calibration factors are typically between 1.0 and 1.5.
