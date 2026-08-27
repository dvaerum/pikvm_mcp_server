# ncnn Python binding: `Mat(numpy_array)` silently returns garbage on read-back

## What happened

While spiking crop-heatmap.onnx → ncnn conversion (Phase 0 feasibility check for
GPU-accelerating cursor detection via Vulkan/ncnn, 2026-08-27), the first numerical
fidelity comparison against onnxruntime came back wildly, catastrophically wrong —
heatmap logit values on the order of `1e18`–`1e20`, versus onnxruntime's sane
`[-3.6, 2.7]` range. This looked like either a broken conversion or a fundamentally
incompatible model, not a test-harness bug.

## Root cause

`ncnn.Mat`'s Python binding has an overload that takes a raw buffer directly:

```python
mat_in = ncnn.Mat(chw_numpy_array)   # looks correct, ISN'T
```

This overload correctly infers `dims`/`w`/`h`/`c` from the array's shape — so a
`print(mat.shape)` sanity check after construction looks completely fine — but it
does **not** actually copy the array's bytes into the Mat's own buffer. Reading the
data back out (`np.array(mat)`) returns uninitialized memory, not the input. This
was caught by round-tripping a random array through `Mat` and comparing to the
original **before** trusting any model output — the round-trip alone showed clearly
garbage values (`-1.66e-06`, `4.08e-41`, ...) with the correct shape.

Confirmed on ncnn Python binding `1.0.20260526`.

## The fix

Construct an *empty* `Mat` with explicit dimensions, then assign through the
writable `.numpy()` view instead of passing the array to the constructor:

```python
mat_in = ncnn.Mat(w, h, c)          # empty, correctly allocated
np.array(mat_in, copy=False)[:] = chw_numpy_array   # writes into the Mat's own buffer
```

Verify with a controlled round-trip (random array in → same array out) before
trusting any real model comparison — the failure mode here doesn't crash or warn,
it just silently returns numbers that happen to look like a napkin-math order of
magnitude wrong, which is easy to misdiagnose as "the model doesn't work" rather
than "the harness fed it garbage."

## Where this matters again

Anyone doing the real ncnn integration (native C++ inference path, or another
Python prototype) should use the empty-Mat + `.numpy()`-view pattern from the
start, not rediscover this by staring at nonsensical logits. The C++ API doesn't
have this exact footgun (it takes typed pointers/dims directly), but any *other*
Python-side ncnn work — a second model, a different conversion tool, a future
model version — can hit the identical trap.

See [[passive-scale-learner]] for the sibling "capture what we learned" doc if a
cross-reference is ever useful; otherwise this stands alone.
