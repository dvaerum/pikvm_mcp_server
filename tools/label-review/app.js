// Label-review client. Vanilla JS, no framework.
//
// Flow:
//   1. fetch /api/datasets, populate dropdown
//   2. when dataset/filter changes, fetch /api/frames and jump to
//      first unverified
//   3. render current frame: image + two markers
//   4. user keys / clicks → POST /api/decision → advance
//
// All native-coord ↔ display-coord math goes through the same scale
// derived from the rendered img.naturalWidth/naturalHeight.

const $ = (id) => document.getElementById(id);

function ensureSessionId() {
  let id = localStorage.getItem('sessionId');
  if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return id;
  // Generate a ~16-char random ID using crypto when available.
  const bytes = new Uint8Array(12);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
  id = Array.from(bytes).map((b) => b.toString(36).padStart(2, '0')).join('');
  localStorage.setItem('sessionId', id);
  return id;
}

const state = {
  // Persist across reloads. If the saved name no longer exists in the
  // server's /api/datasets response, loadDatasets() falls back to the
  // first available one (and writes that back to localStorage).
  dataset: localStorage.getItem('dataset') || 'v0',
  filter: 'all',
  frames: [],          // [{idx, frame_id, label, algorithm_label, verified, claimedByOther}]
  pos: 0,              // index into `frames`
  natW: 0,             // native frame width (from loaded image)
  natH: 0,
  rendW: 0,            // rendered image width in px
  rendH: 0,
  scale: 1,
  // View controls — persisted via localStorage so the rater's preferred
  // zoom + crop survives page reloads and dataset switches.
  // zoom 1 = fit-to-viewport (max-width 100%); >1 = scale up + scroll.
  zoom: Number(localStorage.getItem('zoom')) || 1,
  // 'off' | 'ipad': when 'ipad', the image area centers on the iPad
  // portrait region and hides the surrounding PiKVM black border.
  // Coordinates remain in native px (the crop is a view-only window).
  crop: localStorage.getItem('crop') || 'off',
  // Persistent across reloads. When true, both label + algo arrows stay
  // visible even when the mouse is hovering the image. (Default behavior
  // is to fade them on hover so you can see the bare frame.)
  alwaysShow: localStorage.getItem('alwaysShow') === 'true',
  sessionId: ensureSessionId(),
  // Tracks the in-flight heartbeat target so we can cancel/restart when
  // the frame changes.
  heartbeatFrameId: null,
  heartbeatTimer: null,
  refreshTimer: null,
  // When the user switches frames, we want to land on the same native-pixel
  // viewport center (rather than the default iPad-region center). This is
  // populated by captureViewCenter() right before render() runs and
  // consumed once by applyZoomAndCrop on the new frame.
  pendingScrollCenter: null,
};

const HEARTBEAT_INTERVAL_MS = 20_000;
const REFRESH_INTERVAL_MS = 5_000;  // poll source jsonl every 5 s so live-streaming benches show new frames promptly

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function loadDatasets() {
  const resp = await fetchJson('/api/datasets');
  const list = resp.datasets ?? resp;  // backward-compat with array shape
  const sel = $('dataset-pick');
  sel.innerHTML = '';
  for (const d of list) {
    const opt = document.createElement('option');
    opt.value = d.name;
    opt.textContent = `${d.name} (${d.verified}/${d.total} verified)`;
    sel.appendChild(opt);
  }
  // If the persisted dataset name is no longer served, fall back to the
  // first one in the list (and persist that so refresh stays sticky).
  if (!list.some((d) => d.name === state.dataset)) {
    if (list.length > 0) {
      state.dataset = list[0].name;
      localStorage.setItem('dataset', state.dataset);
    }
  }
  sel.value = state.dataset;
  // Update "active raters" chip (count of all sessions including self).
  const chip = $('active-raters');
  if (chip && typeof resp.activeRaters === 'number') {
    const others = Math.max(0, resp.activeRaters - 1);
    chip.textContent = others === 0 ? 'only you' : `+${others} other rater${others === 1 ? '' : 's'}`;
    chip.classList.toggle('online', others > 0);
  }
  return list;
}

async function loadFrames() {
  state.frames = await fetchJson(
    `/api/frames?dataset=${encodeURIComponent(state.dataset)}` +
    `&filter=${encodeURIComponent(state.filter)}` +
    `&sessionId=${encodeURIComponent(state.sessionId)}`,
  );
  jumpToFirstUnverified();
  render();
}

function isAvailable(f) {
  return (!f.verified || f.verified.decision === 'skip') && !f.claimedByOther;
}

function jumpToFirstUnverified() {
  const i = state.frames.findIndex(isAvailable);
  state.pos = i >= 0 ? i : 0;
}

// Called when the user clicks "Jump to first unverified". If none in
// the current filter, falls back to searching across the whole dataset
// (filter=all) and switches the filter dropdown so the user can see
// what was found.
function flashBanner(msg, kind) {
  const el = $('banner');
  if (!el) { setStatus(msg); return; }
  el.textContent = msg;
  el.className = `banner ${kind || ''}`;
  el.style.display = 'block';
  clearTimeout(flashBanner._t);
  flashBanner._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function jumpToFirstUnverifiedSmart() {
  const local = state.frames.findIndex(isAvailable);
  if (local >= 0) {
    state.pos = local;
    render();
    setStatus(`jumped to position ${local + 1} of ${state.frames.length}`);
    return;
  }
  // Maybe everything unverified is currently claimed by others?
  const localUnverifiedButClaimed = state.frames.some(
    (f) => (!f.verified || f.verified.decision === 'skip') && f.claimedByOther,
  );
  if (localUnverifiedButClaimed) {
    flashBanner(
      'All currently-unverified frames in this filter are claimed by other ' +
      'raters. Try again in a minute or switch filters.',
      'info',
    );
    return;
  }
  if (state.filter !== 'all') {
    // Still in a narrow filter — check the whole dataset before switching.
    const allRows = await fetchJson(
      `/api/frames?dataset=${encodeURIComponent(state.dataset)}&filter=all` +
      `&sessionId=${encodeURIComponent(state.sessionId)}`,
    );
    if (allRows.find(isAvailable)) {
      flashBanner(`No available frames in "${state.filter}" filter — switching to "all".`, 'info');
      state.filter = 'all';
      $('filter-pick').value = 'all';
      await loadFrames();
      return;
    }
  }
  // Current dataset has no unverified frames. Look across all datasets
  // for one with available work, switch to it.
  const resp = await fetchJson('/api/datasets');
  const list = resp.datasets ?? resp;
  const candidate = list.find(
    (d) => d.name !== state.dataset && d.verified < d.total,
  );
  if (!candidate) {
    flashBanner(`✓ All datasets fully verified.`, 'success');
    return;
  }
  flashBanner(
    `✓ "${state.dataset}" done — switching to "${candidate.name}" (${candidate.total - candidate.verified} unverified left).`,
    'info',
  );
  state.dataset = candidate.name;
  localStorage.setItem('dataset', state.dataset);
  $('dataset-pick').value = state.dataset;
  state.filter = 'all';
  $('filter-pick').value = 'all';
  await loadFrames();
}

function currentFrame() {
  return state.frames[state.pos];
}

function setMarker(el, x, y) {
  if (x == null || y == null) {
    el.style.display = 'none';
    return;
  }
  const dx = x * state.scale;
  const dy = y * state.scale;
  el.style.display = '';
  el.style.left = dx + 'px';
  el.style.top = dy + 'px';
}

// PiKVM letterbox bounds for the iPad region. Auto-detected from the
// image content per (natW, natH), cached so we only pay the canvas
// readback once per frame size. Replaces an earlier hardcoded 1680×1050
// region that was wrong for the 1920×1080 captures the current bench
// produces.
const ipadRegionCache = new Map();

function detectIpadRegion(img) {
  const key = `${img.naturalWidth}x${img.naturalHeight}`;
  const cached = ipadRegionCache.get(key);
  if (cached) return cached;

  // Downscale to a small canvas for fast pixel scanning.
  const W = 240;
  const H = Math.round(W * img.naturalHeight / img.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, W, H).data;
  } catch (e) {
    // Tainted canvas (cross-origin) — fall back to no crop.
    const fallback = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    ipadRegionCache.set(key, fallback);
    return fallback;
  }

  // Column / row brightness sums. A "content" col/row has avg luminance > 12.
  // Black PiKVM letterbox bars are <5; iPad UI is much brighter.
  const colBright = new Float32Array(W);
  const rowBright = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      colBright[x] += lum;
      rowBright[y] += lum;
    }
  }
  for (let x = 0; x < W; x++) colBright[x] /= H;
  for (let y = 0; y < H; y++) rowBright[y] /= W;

  const BRIGHT_THRESHOLD = 12;
  const firstBright = (arr) => {
    for (let i = 0; i < arr.length; i++) if (arr[i] > BRIGHT_THRESHOLD) return i;
    return 0;
  };
  const lastBright = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] > BRIGHT_THRESHOLD) return i;
    return arr.length - 1;
  };

  const x0 = firstBright(colBright);
  const x1 = lastBright(colBright);
  const y0 = firstBright(rowBright);
  const y1 = lastBright(rowBright);

  // Scale back to native pixels with a small margin so cursors right at
  // the iPad screen edge aren't cut off.
  const sx = img.naturalWidth / W;
  const sy = img.naturalHeight / H;
  const MARGIN = 6;  // native px
  const region = {
    x: Math.max(0, Math.round(x0 * sx) - MARGIN),
    y: Math.max(0, Math.round(y0 * sy) - MARGIN),
    w: Math.min(img.naturalWidth, Math.round((x1 - x0 + 1) * sx) + 2 * MARGIN),
    h: Math.min(img.naturalHeight, Math.round((y1 - y0 + 1) * sy) + 2 * MARGIN),
  };
  // Sanity: if the detected region is <30% of the frame, fall back to
  // full frame (likely an all-black frame or detection failed).
  if (region.w * region.h < img.naturalWidth * img.naturalHeight * 0.3) {
    const fallback = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    ipadRegionCache.set(key, fallback);
    return fallback;
  }
  ipadRegionCache.set(key, region);
  return region;
}

function applyZoomAndCrop() {
  const img = $('frame-img');
  const area = $('image-area');
  const wrap = $('image-wrap');
  if (!img.naturalWidth) return;

  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  const areaW = area.clientWidth;
  const areaH = area.clientHeight;

  // Auto-detect the iPad region (cached per frame size) when in iPad-only
  // mode. Replaces the prior 1680×1050 hardcoded constant that was wrong
  // for the 1920×1080 captures.
  const ipadRegion = state.crop === 'ipad' ? detectIpadRegion(img) : null;

  // Baseline fit. When iPad-only, scale so the iPad region fills the
  // viewport WIDTH (the iPad is usually taller than the viewport, so
  // fitting to width gives the largest visible iPad and you scroll
  // vertically). Don't fit both axes — that makes the iPad tiny.
  let baseFit;
  if (ipadRegion) {
    baseFit = areaW / ipadRegion.w;
  } else {
    baseFit = Math.min(areaW / natW, areaH / natH);
  }
  const displayScale = baseFit * state.zoom;
  const newW = natW * displayScale;
  const newH = natH * displayScale;

  // When zoomed past viewport, we want overflow:auto so user can scroll/pan.
  const overflows = newW > areaW || newH > areaH;
  area.classList.toggle('zoomed', overflows);

  img.style.width = newW + 'px';
  img.style.height = newH + 'px';
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  wrap.style.width = newW + 'px';
  wrap.style.height = newH + 'px';

  state.natW = natW;
  state.natH = natH;
  state.rendW = newW;
  state.rendH = newH;
  state.scale = newW / natW;

  // Scroll positioning. Priority:
  //  1. A pending scroll-center carried over from the previous frame so
  //     the user stays anchored on the same spot when navigating.
  //  2. In iPad-only mode with no carry-over, center on the iPad region.
  // Both compute scrollLeft/scrollTop from a native-image-pixel center.
  if (overflows) {
    let centerNative = state.pendingScrollCenter;
    state.pendingScrollCenter = null;  // consume once
    if (!centerNative && state.crop === 'ipad' && ipadRegion) {
      centerNative = {
        x: ipadRegion.x + ipadRegion.w / 2,
        y: ipadRegion.y + ipadRegion.h / 2,
      };
    }
    if (centerNative) {
      const maxScrollX = Math.max(0, newW - areaW);
      const maxScrollY = Math.max(0, newH - areaH);
      area.scrollLeft = Math.max(0, Math.min(maxScrollX,
        Math.round(centerNative.x * state.scale - areaW / 2)));
      area.scrollTop = Math.max(0, Math.min(maxScrollY,
        Math.round(centerNative.y * state.scale - areaH / 2)));
    }
  }

  // Refresh the zoom-controls label and active-button state.
  updateZoomUI();
}

function updateZoomUI() {
  const lbl = $('zoom-label');
  if (lbl) lbl.textContent = `${state.zoom.toFixed(state.zoom >= 1 ? 1 : 2).replace(/\.0$/, '')}×`;
  const crop = $('crop-toggle');
  if (crop) crop.classList.toggle('active', state.crop === 'ipad');
}

function setZoom(z) {
  state.zoom = Math.max(0.25, Math.min(16, z));
  localStorage.setItem('zoom', String(state.zoom));
  applyZoomAndCrop();
  // Re-position markers after scale change.
  renderMarkers();
}

function setCrop(mode) {
  state.crop = mode === 'ipad' ? 'ipad' : 'off';
  localStorage.setItem('crop', state.crop);
  applyZoomAndCrop();
  renderMarkers();
}

function renderMarkers() {
  const f = currentFrame();
  if (!f) return;
  const lx = f.label?.visible ? f.label.x : null;
  const ly = f.label?.visible ? f.label.y : null;
  setMarker($('label-marker'), lx, ly);
  const algo = f.algorithm_label;
  setMarker($('algo-marker'), algo?.x ?? null, algo?.y ?? null);
  const vc = f.verified?.cursor;
  setMarker($('verified-marker'),
    vc && vc.visible ? vc.x : null,
    vc && vc.visible ? vc.y : null);
}

function recomputeScale() {
  // Always go through applyZoomAndCrop so the zoom/crop state is honored.
  applyZoomAndCrop();
}

function render() {
  const f = currentFrame();
  if (!f) {
    $('frame-name').textContent = '— no frames in filter —';
    $('progress').textContent = `0 of 0 (filter: ${state.filter})`;
    $('frame-img').src = '';
    $('label-marker').style.display = 'none';
    $('algo-marker').style.display = 'none';
    $('verified-marker').style.display = 'none';
    $('verified-info').style.display = 'none';
    stopHeartbeat();
    setStatus('');
    return;
  }
  $('frame-name').textContent = f.frame_id;
  $('progress').textContent = `${state.pos + 1} of ${state.frames.length} (filter: ${state.filter})`;

  // Visibility badge.
  const badge = $('visibility-badge');
  if (!f.label) {
    badge.textContent = 'NO LABEL';
    badge.className = 'unknown';
  } else if (f.label.visible) {
    badge.textContent = `VISIBLE @ (${f.label.x}, ${f.label.y})`;
    badge.className = 'visible';
  } else {
    badge.textContent = 'ABSENT';
    badge.className = 'absent';
  }

  // Coord readout (label + algo + verified + live hover).
  $('label-coords').textContent =
    f.label?.visible ? `(${f.label.x}, ${f.label.y})` : '—';
  const a = f.algorithm_label;
  $('algo-coords').textContent = a ? `(${a.x}, ${a.y})` : '—';
  const vcur = f.verified?.cursor;
  $('verified-coords').textContent =
    vcur && vcur.visible ? `(${vcur.x}, ${vcur.y})` : '—';
  $('hover-coords').textContent = '—';  // cleared per frame; mousemove fills it

  // Verified info.
  const vinfo = $('verified-info');
  if (f.verified) {
    let txt = `Prior decision: ${f.verified.decision}`;
    if (f.verified.cursor) {
      txt += f.verified.cursor.visible
        ? ` @ (${f.verified.cursor.x}, ${f.verified.cursor.y})`
        : ' (absent)';
    }
    vinfo.textContent = txt;
    vinfo.style.display = '';
  } else {
    vinfo.style.display = 'none';
  }

  // Load image. Image-load callback positions markers and recomputes
  // scale once natural dimensions are known.
  const img = $('frame-img');
  img.onload = () => {
    recomputeScale();
    const lx = f.label?.visible ? f.label.x : null;
    const ly = f.label?.visible ? f.label.y : null;
    setMarker($('label-marker'), lx, ly);
    const algo = f.algorithm_label;
    setMarker($('algo-marker'), algo?.x ?? null, algo?.y ?? null);
    const vc = f.verified?.cursor;
    setMarker($('verified-marker'),
      vc && vc.visible ? vc.x : null,
      vc && vc.visible ? vc.y : null);
  };
  img.src =
    `/api/image?dataset=${encodeURIComponent(state.dataset)}` +
    `&frame_id=${encodeURIComponent(f.frame_id)}`;

  // Restart the heartbeat for this frame.
  startHeartbeatFor(f.frame_id);

  setStatus('');
}

// --- Heartbeat / claim handling ---

async function sendHeartbeat(frameId) {
  try {
    await fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        dataset: state.dataset,
        frameId,
      }),
    });
  } catch {
    // Network blip; next interval will retry.
  }
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  state.heartbeatFrameId = null;
}

function startHeartbeatFor(frameId) {
  if (state.heartbeatFrameId === frameId && state.heartbeatTimer) return;
  stopHeartbeat();
  state.heartbeatFrameId = frameId;
  if (document.visibilityState === 'hidden') return;
  sendHeartbeat(frameId);
  state.heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') {
      stopHeartbeat();
      return;
    }
    sendHeartbeat(state.heartbeatFrameId);
  }, HEARTBEAT_INTERVAL_MS);
}

async function backgroundRefresh() {
  try {
    const fresh = await fetchJson(
      `/api/frames?dataset=${encodeURIComponent(state.dataset)}` +
      `&filter=${encodeURIComponent(state.filter)}` +
      `&sessionId=${encodeURIComponent(state.sessionId)}`,
    );
    // Initial case: dataset was empty (live-collecting bench just started
    // writing). Adopt the fresh list and re-render once frames exist.
    if (state.frames.length === 0) {
      if (fresh.length === 0) { loadDatasets().catch(() => undefined); return; }
      state.frames = fresh;
      jumpToFirstUnverified();
      render();
      loadDatasets().catch(() => undefined);
      return;
    }
    // Merge: update existing rows (status changes from other raters)
    // AND append any new rows the source jsonl has gained since last
    // fetch (e.g. live bench streaming frames in). frame_id is stable so
    // we can dedupe by it.
    const haveIds = new Set(state.frames.map((r) => r.frame_id));
    const byNewId = new Map(fresh.map((r) => [r.frame_id, r]));
    for (let i = 0; i < state.frames.length; i++) {
      const upd = byNewId.get(state.frames[i].frame_id);
      if (upd) state.frames[i] = upd;
    }
    let appended = 0;
    for (const r of fresh) {
      if (!haveIds.has(r.frame_id)) {
        state.frames.push(r);
        appended++;
      }
    }
    if (appended > 0) {
      flashBanner(`+${appended} new frame${appended === 1 ? '' : 's'} added`, 'info');
      // Refresh progress display + dropdown counts.
      const f = currentFrame();
      if (f) {
        $('progress').textContent = `${state.pos + 1} of ${state.frames.length} (filter: ${state.filter})`;
      }
    }
    loadDatasets().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

function setStatus(msg) {
  $('status').textContent = msg;
}

async function decide(decision, cursor) {
  const f = currentFrame();
  if (!f) return;
  const payload = {
    dataset: state.dataset,
    frame_id: f.frame_id,
    decision,
    sessionId: state.sessionId,
  };
  if (cursor) payload.cursor = cursor;
  setStatus(`saving ${decision}…`);
  const r = await fetch('/api/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    setStatus(`error: ${r.status}`);
    return;
  }
  // Update local cache so subsequent navigation shows the verified state.
  f.verified = (await r.json()).entry;
  setStatus(`saved: ${decision}`);
  // Refresh the dataset picker's verified-count by reloading datasets.
  loadDatasets();
  advance();
}

// Capture the centerpoint of the visible viewport in native-image px
// before navigating, so the next frame restores the same view location.
function captureViewCenter() {
  const area = $('image-area');
  if (!area || !state.scale) return;
  state.pendingScrollCenter = {
    x: (area.scrollLeft + area.clientWidth / 2) / state.scale,
    y: (area.scrollTop + area.clientHeight / 2) / state.scale,
  };
}

function advance() {
  // Move forward to the next frame the user can actually work on:
  // not already verified by anyone, and not currently claimed by a
  // different session. If none ahead, just step by one.
  captureViewCenter();
  let i = state.pos + 1;
  while (i < state.frames.length && !isAvailable(state.frames[i])) i++;
  state.pos = i < state.frames.length ? i : Math.min(state.pos + 1, state.frames.length - 1);
  render();
}
function back() {
  if (state.pos > 0) {
    captureViewCenter();
    state.pos--;
  }
  render();
}

// Bound to ArrowRight. Step to the very next frame regardless of its
// verified state. (advance() skips ahead to the next unverified+unclaimed
// frame and is kept for the post-decision auto-advance behavior.)
function stepForward() {
  if (state.pos < state.frames.length - 1) {
    captureViewCenter();
    state.pos++;
  }
  render();
}

function onImageClick(ev) {
  const f = currentFrame();
  if (!f) return;
  const img = $('frame-img');
  const rect = img.getBoundingClientRect();
  const dx = ev.clientX - rect.left;
  const dy = ev.clientY - rect.top;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return;
  const nativeX = Math.round(dx / state.scale);
  const nativeY = Math.round(dy / state.scale);

  // Show a ping at the click location.
  const ping = document.createElement('div');
  ping.className = 'click-ping';
  ping.style.left = dx + 'px';
  ping.style.top = dy + 'px';
  $('image-wrap').appendChild(ping);
  setTimeout(() => ping.remove(), 700);

  decide('correct', { visible: true, x: nativeX, y: nativeY });
}

function applyAlwaysShow() {
  const wrap = $('image-wrap');
  wrap.classList.toggle('always-show', state.alwaysShow);
  const btn = $('btn-always-show');
  if (btn) btn.setAttribute('aria-pressed', String(state.alwaysShow));
  const ind = $('always-show-state');
  if (ind) ind.textContent = state.alwaysShow ? 'on' : 'off';
}

function toggleAlwaysShow() {
  state.alwaysShow = !state.alwaysShow;
  localStorage.setItem('alwaysShow', String(state.alwaysShow));
  applyAlwaysShow();
}

function bindKeys() {
  document.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLSelectElement) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (k === 'c' || k === 'Enter') { ev.preventDefault(); decide('confirm', cursorFromLabel()); }
    else if (k === 'a') { ev.preventDefault(); decide('absent', { visible: false }); }
    else if (k === 's') { ev.preventDefault(); decide('skip'); }
    else if (k === 'h') { ev.preventDefault(); toggleAlwaysShow(); }
    else if (k === 'u') { ev.preventDefault(); jumpToFirstUnverifiedSmart(); }
    else if (k === 'ArrowLeft') { ev.preventDefault(); back(); }
    else if (k === 'ArrowRight') { ev.preventDefault(); stepForward(); }
    // View controls: zoom + crop (trim).
    else if (k === '+' || k === '=') { ev.preventDefault(); setZoom(state.zoom * 1.5); }
    else if (k === '-' || k === '_') { ev.preventDefault(); setZoom(state.zoom / 1.5); }
    else if (k === '0') { ev.preventDefault(); setZoom(1); }
    else if (k === 't') { ev.preventDefault(); setCrop(state.crop === 'ipad' ? 'off' : 'ipad'); }
  });
}

function cursorFromLabel() {
  const f = currentFrame();
  if (!f) return undefined;
  // Prefer the original label if it exists.
  if (f.label) {
    if (!f.label.visible) return { visible: false };
    return { visible: true, x: f.label.x, y: f.label.y };
  }
  // No original label (e.g. v7-pre-labelled v0/emit). Treat Confirm as
  // "this algorithm prediction is correct" and record its coords.
  if (f.algorithm_label) {
    return {
      visible: true,
      x: f.algorithm_label.x,
      y: f.algorithm_label.y,
    };
  }
  return undefined;
}

function bindUI() {
  $('dataset-pick').addEventListener('change', () => {
    state.dataset = $('dataset-pick').value;
    localStorage.setItem('dataset', state.dataset);
    loadFrames();
  });
  $('filter-pick').addEventListener('change', () => {
    state.filter = $('filter-pick').value;
    loadFrames();
  });
  $('jump-unverified').addEventListener('click', jumpToFirstUnverifiedSmart);
  $('btn-confirm').addEventListener('click', () => decide('confirm', cursorFromLabel()));
  $('btn-absent').addEventListener('click', () => decide('absent', { visible: false }));
  $('btn-skip').addEventListener('click', () => decide('skip'));
  $('btn-prev').addEventListener('click', back);
  $('btn-next').addEventListener('click', advance);
  $('btn-always-show').addEventListener('click', toggleAlwaysShow);

  // Zoom + crop controls.
  $('zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.5));
  $('zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.5));
  $('zoom-fit').addEventListener('click', () => setZoom(1));
  $('crop-toggle').addEventListener('click', () => setCrop(state.crop === 'ipad' ? 'off' : 'ipad'));
  updateZoomUI();
  // Re-apply zoom/crop on window resize so it stays aligned.
  window.addEventListener('resize', () => {
    if ($('frame-img').naturalWidth) applyZoomAndCrop();
  });

  const wrap = $('image-wrap');
  wrap.addEventListener('mouseenter', () => wrap.classList.add('hovered'));
  wrap.addEventListener('mouseleave', () => {
    wrap.classList.remove('hovered');
    wrap.classList.remove('near-marker');
    $('hover-coords').textContent = '—';
  });
  const img = $('frame-img');
  img.addEventListener('click', onImageClick);
  img.addEventListener('mousemove', (ev) => {
    if (state.scale <= 0) return;
    const rect = img.getBoundingClientRect();
    const mxScreen = ev.clientX - rect.left;
    const myScreen = ev.clientY - rect.top;
    const nx = Math.round(mxScreen / state.scale);
    const ny = Math.round(myScreen / state.scale);
    $('hover-coords').textContent = `(${nx}, ${ny})`;
    // Always-show mode: fade the arrows when the mouse pointer is
    // within 20 px (screen) of any visible arrow tip so the cursor
    // beneath them is reachable.
    if (state.alwaysShow) {
      const f = currentFrame();
      const tips = [];
      if (f?.label?.visible) tips.push([f.label.x, f.label.y]);
      if (f?.algorithm_label) tips.push([f.algorithm_label.x, f.algorithm_label.y]);
      const vc = f?.verified?.cursor;
      if (vc && vc.visible) tips.push([vc.x, vc.y]);
      let near = false;
      for (const [tx, ty] of tips) {
        const dx = tx * state.scale - mxScreen;
        const dy = ty * state.scale - myScreen;
        if (dx * dx + dy * dy < 20 * 20) { near = true; break; }
      }
      wrap.classList.toggle('near-marker', near);
    } else if (wrap.classList.contains('near-marker')) {
      wrap.classList.remove('near-marker');
    }
  });

  window.addEventListener('resize', () => {
    recomputeScale();
    render();  // re-position markers
  });
}

async function main() {
  bindUI();
  bindKeys();
  applyAlwaysShow();  // sync the button/indicator with persisted state
  // Tab hidden/visible: hidden releases the claim within one TTL; visible
  // restarts the heartbeat for the current frame.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopHeartbeat();
    } else if (state.heartbeatFrameId == null) {
      const f = currentFrame();
      if (f) startHeartbeatFor(f.frame_id);
    }
  });
  // Periodic background refresh picks up other raters' progress.
  state.refreshTimer = setInterval(backgroundRefresh, REFRESH_INTERVAL_MS);
  await loadDatasets();
  await loadFrames();
}

main().catch((e) => {
  setStatus(`error: ${e.message}`);
  console.error(e);
});
