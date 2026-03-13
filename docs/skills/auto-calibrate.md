# auto-calibrate

> MCP Prompt: `auto-calibrate`

Guide for automatic mouse calibration with pikvm_auto_calibrate.

## Arguments

None.

## How It Works

`pikvm_auto_calibrate` detects the cursor by moving it a known distance and diffing pairs of screenshots:

1. Moves the mouse to a random position, takes screenshot A
2. Moves a known delta (80-150px), takes screenshot B
3. Diffs A and B to find cursor-sized pixel clusters
4. Compares detected movement vector to commanded delta
5. Repeats across multiple rounds to collect samples
6. Computes calibration factors from median of detected/expected ratios
7. Verifies by moving to random targets and checking accuracy

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| rounds | number | 5 | Sampling rounds |
| verifyRounds | number | 5 | Verification rounds |
| moveDelayMs | number | 300 | Delay after each mouse move (ms) |

## Example

```json
{ "name": "pikvm_auto_calibrate" }
```

With custom delay for slow connections:

```json
{ "name": "pikvm_auto_calibrate", "arguments": { "moveDelayMs": 500 } }
```

## Tips

- Preferred over manual calibration — try this first.
- Other tools are blocked during calibration.
- Increase `moveDelayMs` if calibration fails on slow connections.
- Works best on a static desktop without animations or videos near the cursor.
- Falls back gracefully with a suggestion to use manual calibration if detection fails.
