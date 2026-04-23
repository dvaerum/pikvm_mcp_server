# pikvm_measure_ballistics — Characterize iPad/Relative-Mouse Ballistics

## Purpose
When the PiKVM target uses `mouse.absolute=false` (e.g. iPad), deltas have a non-trivial, non-linear pixel/mickey ratio because of OS-side pointer acceleration. This tool slams the cursor to a known corner, sweeps (axis × magnitude × pace × rep), and writes a JSON profile to `./data/ballistics.json`. The profile is consulted by `pikvm_mouse_move_to` and `pikvm_mouse_click_at`.

## When to Run
- Once per device + orientation + resolution.
- When your observed move-to accuracy degrades (e.g. after iPadOS updates that change pointer acceleration).

## Caveats (read before running)
- **Needs a quiet screen.** On the iPad home screen, animated widgets (clock second hand, weather ticker) produce so many pixel diffs that cursor detection mis-locks on them. Navigate to a static screen first — iPad Settings, a blank Safari page, or the lock screen.
- **Results have variance.** Even on quiet screens, per-cell medians can vary 2-4× between runs because iPad auto-hides the cursor and pointer-effect rendering perturbs the diff. Treat the profile as a *hint*, not ground truth.
- **Takes ~1-5 minutes** depending on rep count.

## Parameters
| Parameter | Type | Default | Description |
|---|---|---|---|
| magnitudes | number[] | [5,10,20,40,80,127] | Per-call delta magnitudes to sample |
| paces | string[] | ['fast','slow'] | Pace modes |
| axes | string[] | ['x','y'] | Axes to sample |
| reps | number | 2 | Repetitions per cell |
| callsPerCell | number | 5 | Delta calls emitted per cell |
| slowPaceMs | number | 30 | Ms between calls in slow pace |
| settleMs | number | 150 | Ms before screenshots |
| profilePath | string | `./data/ballistics.json` | Profile output path |
| verbose | boolean | false | Log per-cell diagnostics to stderr |

## Example Calls
```json
{ "name": "pikvm_measure_ballistics", "arguments": {} }

{ "name": "pikvm_measure_ballistics", "arguments": { "magnitudes": [127], "paces": ["slow"], "reps": 5, "verbose": true } }
```

## Tips
- If `samplesAccepted` is much less than the total sweep size, the screen was too noisy — navigate to a quieter view and retry.
- A reasonable default empirical value on iPad is **~1.0 px/mickey at mag=127, pace=slow** — if your profile's medians are far from that, re-check the target screen.
- You can skip this tool entirely. `pikvm_mouse_move_to` falls back to 1.0 px/mickey when no profile exists, and its output screenshot lets the caller close the loop visually.
