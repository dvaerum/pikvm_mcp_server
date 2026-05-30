# Label review

Browser-based tool for human verification of cursor-detection training
labels. Walks through each labeled frame, shows the existing label
as a colored marker on the image, and lets you confirm / correct /
mark-absent / skip.

Human decisions go into the per-dataset output file you specify.
The source `verified.jsonl` files are never modified.

## Run

Easiest — point it at the repo root and use the project-standard
datasets:

```bash
npx tsx tools/label-review/server.ts --repo .
# open http://127.0.0.1:8765
```

Via the flake (from any directory inside the checkout):

```bash
nix run .#label-review
```

## CLI options

```
--port <n>         HTTP port                              (default: 8765)
--host <addr>      Bind address                           (default: 127.0.0.1)
--dataset <spec>   Add a dataset (repeatable, see below)
--repo <path>      Shortcut: declare the two project-standard datasets
                   rooted at <path>/data/
```

Either `--repo` or at least one `--dataset` is required.

### `--dataset` spec

A comma-separated `key=value` list. Required keys:

| key        | meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `name`     | dataset identifier (used in URLs and stored in output)                  |
| `jsonl`    | path to the source `verified.jsonl`                                      |
| `verified` | path where decisions get appended (created on first write)               |
| `images`   | `abs` — image is `entry.abs_frame_path`<br>`dir:<path>` — image is `<path>/<entry.frame>` |

Example with explicit datasets:

```bash
npx tsx tools/label-review/server.ts \
  --host 0.0.0.0 --port 9000 \
  --dataset name=v0,jsonl=./data/cursor-training-v0/verified.jsonl,verified=./data/cursor-training-v0/human-verified.jsonl,images=dir:./data/cursor-training-v0 \
  --dataset name=emit,jsonl=./data/cursor-training-v0-emit/verified.jsonl,verified=./data/cursor-training-v0-emit/human-verified.jsonl,images=abs
```

## UI

- **Image area**: the frame, fit to window. Two markers overlaid:
  - **green** = the existing label
  - **yellow** = the algorithm-generated label (`algorithm_label`)
- **Hover the image** → both markers fade so you can see the bare
  frame. Move the mouse off the image to bring them back.
- **Side panel**: frame name, visibility badge, decision buttons,
  prior-decision indicator, navigation, keyboard hints.

## Actions

| Action     | Keyboard       | Effect                                                                |
| ---------- | -------------- | --------------------------------------------------------------------- |
| Confirm    | `c` or `Enter` | The existing label is correct                                         |
| Correct    | click image    | Replaces the label with your clicked coords (in native frame px)     |
| Mark absent| `a`            | No cursor visible in this frame                                       |
| Skip       | `s`            | Defer; frame remains unverified for future sessions                   |
| Previous   | `←`            | Back one frame in the current filter                                  |
| Next       | `→`            | Forward one frame                                                     |

## Filters

- **All unverified** (default) — frames without a non-skip decision
- **Label says visible** / **Label says absent** — filter by current label
- **Algo disagrees ≥ 50 / 100 px** — suspect frames where algorithm
  and human-rater disagreed

Within a filter, frames are sorted by `frame_id` for deterministic
order.

## Output

`<verified-path>`, one line per decision, append-only. Latest
decision per frame wins on read.

```jsonl
{"frame":"2026-05-13_05-33-56_0000_A.jpg","source_dataset":"v0","decision":"confirm","cursor":{"visible":true,"x":1151,"y":777},"decided_at":"2026-05-20T10:42:00Z"}
```

Schema:

- `frame` — the unique frame ID inside the dataset
- `source_dataset` — the configured dataset `name`
- `decision` — `"confirm" | "correct" | "absent" | "skip"`
- `cursor` — present for confirm/correct/absent; omitted for skip
- `decided_at` — ISO timestamp

## Resume behavior

On reload, the tool re-reads the configured `verified` file for the
active dataset and jumps to the first frame whose latest decision is
either `skip` or unrecorded.

## End-to-end browser verification

`tools/label-review/verify-browser.ts` drives a headless Chromium
through the full workflow and asserts every action against the
on-disk output. Pre-conditions: the server must already be running.

```bash
# Start the server in one terminal:
npx tsx tools/label-review/server.ts --repo .

# In another terminal:
npx tsx tools/label-review/verify-browser.ts --repo .
```

Or with explicit dataset paths:

```bash
npx tsx tools/label-review/verify-browser.ts \
  --url http://127.0.0.1:8765 \
  --primary name=v0,verified=./data/cursor-training-v0/human-verified.jsonl \
  --secondary name=emit,verified=./data/cursor-training-v0-emit/human-verified.jsonl \
  --shots-dir ./my-shots
```

Other options: `--shots-dir <path>`.

> Note: the verification test wipes both `--verified` files before
> running so it can re-create them from scratch. Don't point it at a
> dataset that has real human decisions you want to keep.
