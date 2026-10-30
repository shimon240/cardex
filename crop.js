// Crop editor: the user frames the word on the photo, and only that part is sent to Grok.
// Drag corners/edges to resize, drag inside to move, drag outside to draw a new frame,
// two fingers to zoom and pan. After each change the view zooms in on the frame.

const MAX_SIDE = 2400;  // working photo size, px
const OUT_SIDE = 1600;  // max side of the image sent to Grok, px
const MIN_CROP = 32;    // min frame side on screen, CSS px
const HANDLE = 26;      // touch radius around corners and edges, CSS px
const INSET = 20;       // gap between the photo and the screen edge, CSS px
const FILL = 0.8;       // share of the area the frame fills after zooming in
const MAX_K = 3;        // max zoom: screen px per photo px

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось открыть фото"));
    };
    img.src = url;
  });
}

// Opens the editor for a photo file. Resolves with a JPEG data URL of the cropped
// part, or null if the user cancels.
export async function openCrop(file) {
  const photo = await loadPhoto(file);
  const W = photo.width;
  const H = photo.height;

  const root = $("#crop");
  const area = $("#crop-area");
  const stage = $("#crop-stage");
  const canvas = $("#crop-photo");
  const box = $("#crop-box");
  const resetBtn = $("#crop-reset");
  const goBtn = $("#crop-go");
  const cancelBtn = $("#crop-cancel");

  canvas.width = W;
  canvas.height = H;
  canvas.getContext("2d").drawImage(photo, 0, 0);
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;

  root.hidden = false;
  document.body.style.overflow = "hidden";

  /* view: screen = t + photo * k */
  const view = { k: 1, tx: 0, ty: 0 };
  let crop = { x0: 0, y0: 0, x1: W, y1: H };
  let anim = 0;

  function areaSize() {
    const r = area.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  }
  function minK() {
    const a = areaSize();
    return Math.min((a.w - INSET * 2) / W, (a.h - INSET * 2) / H);
  }

  function render() {
    stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`;
    const l = view.tx + crop.x0 * view.k;
    const t = view.ty + crop.y0 * view.k;
    box.style.transform = `translate(${l}px, ${t}px)`;
    box.style.width = `${(crop.x1 - crop.x0) * view.k}px`;
    box.style.height = `${(crop.y1 - crop.y0) * view.k}px`;
    resetBtn.disabled = crop.x0 === 0 && crop.y0 === 0 && crop.x1 === W && crop.y1 === H;
  }

  function targetView() {
    const a = areaSize();
    const cw = crop.x1 - crop.x0;
    const ch = crop.y1 - crop.y0;
    const kLo = minK();
    const k = clamp(Math.min((a.w * FILL) / cw, (a.h * FILL) / ch), kLo, Math.max(kLo, MAX_K));
    return {
      k,
      tx: a.w / 2 - ((crop.x0 + crop.x1) / 2) * k,
      ty: a.h / 2 - ((crop.y0 + crop.y1) / 2) * k,
    };
  }

  function refit(animate = true) {
    cancelAnimationFrame(anim);
    const to = targetView();
    if (!animate) {
      Object.assign(view, to);
      return render();
    }
    const from = { ...view };
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / 240);
      const e = 1 - Math.pow(1 - p, 3);
      view.k = from.k + (to.k - from.k) * e;
      view.tx = from.tx + (to.tx - from.tx) * e;
      view.ty = from.ty + (to.ty - from.ty) * e;
      render();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  refit(false);

  function local(e) {
    const a = areaSize();
    return { x: e.clientX - a.left, y: e.clientY - a.top };
  }
  function toPhoto(p) {
    return { x: (p.x - view.tx) / view.k, y: (p.y - view.ty) / view.k };
  }

  // Which frame edges a screen point grabs: corners grab two, sides one.
  function hit(p) {
    const l = view.tx + crop.x0 * view.k;
    const r = view.tx + crop.x1 * view.k;
    const t = view.ty + crop.y0 * view.k;
    const b = view.ty + crop.y1 * view.k;
    const inY = p.y > t - HANDLE && p.y < b + HANDLE;
    const inX = p.x > l - HANDLE && p.x < r + HANDLE;
    const edges = {
      l: inY && Math.abs(p.x - l) < HANDLE,
      r: inY && Math.abs(p.x - r) < HANDLE,
      t: inX && Math.abs(p.y - t) < HANDLE,
      b: inX && Math.abs(p.y - b) < HANDLE,
    };
    // On a tiny frame both opposite edges may match; keep the closer one.
    if (edges.l && edges.r) Math.abs(p.x - l) < Math.abs(p.x - r) ? (edges.r = false) : (edges.l = false);
    if (edges.t && edges.b) Math.abs(p.y - t) < Math.abs(p.y - b) ? (edges.b = false) : (edges.t = false);
    if (edges.l || edges.r || edges.t || edges.b) return { mode: "resize", edges };
    // A full-photo frame cannot move, so dragging inside it draws a new one.
    const full = crop.x0 === 0 && crop.y0 === 0 && crop.x1 === W && crop.y1 === H;
    if (!full && p.x > l && p.x < r && p.y > t && p.y < b) return { mode: "move" };
    return { mode: "new" };
  }

  /* gestures */
  const pointers = new Map();
  let gesture = null;
  const ac = new AbortController();
  const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal: ac.signal });

  function startPinch() {
    const [a, b] = [...pointers.values()];
    gesture = {
      mode: "pinch",
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      k0: view.k, tx0: view.tx, ty0: view.ty,
    };
  }

  on(area, "pointerdown", (e) => {
    e.preventDefault();
    cancelAnimationFrame(anim);
    area.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      const p = local(e);
      gesture = { ...hit(p), start: toPhoto(p), before: { ...crop } };
      box.classList.add("active");
    } else if (pointers.size === 2) {
      // A second finger turns whatever the first one started into a pinch.
      if (gesture?.before) crop = gesture.before;
      startPinch();
      render();
    }
  });

  on(area, "pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, local(e));

    if (gesture.mode === "pinch") {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const kLo = minK();
      const k = clamp(gesture.k0 * (d / gesture.d0), kLo * 0.8, Math.max(kLo, MAX_K) * 1.5);
      const cx = (gesture.m0.x - gesture.tx0) / gesture.k0;
      const cy = (gesture.m0.y - gesture.ty0) / gesture.k0;
      view.k = k;
      view.tx = m.x - cx * k;
      view.ty = m.y - cy * k;
      return render();
    }

    const p = toPhoto(local(e));
    const min = MIN_CROP / view.k;
    const c = { ...gesture.before };

    if (gesture.mode === "move") {
      const w = c.x1 - c.x0;
      const h = c.y1 - c.y0;
      const x0 = clamp(c.x0 + p.x - gesture.start.x, 0, W - w);
      const y0 = clamp(c.y0 + p.y - gesture.start.y, 0, H - h);
      crop = { x0, y0, x1: x0 + w, y1: y0 + h };
    } else if (gesture.mode === "resize") {
      const { edges } = gesture;
      if (edges.l) c.x0 = clamp(p.x, 0, c.x1 - min);
      if (edges.r) c.x1 = clamp(p.x, c.x0 + min, W);
      if (edges.t) c.y0 = clamp(p.y, 0, c.y1 - min);
      if (edges.b) c.y1 = clamp(p.y, c.y0 + min, H);
      crop = c;
    } else if (gesture.mode === "new") {
      const s = gesture.start;
      const q = { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) };
      if (Math.abs(q.x - s.x) < min || Math.abs(q.y - s.y) < min) return;
      crop = {
        x0: clamp(Math.min(s.x, q.x), 0, W), x1: clamp(Math.max(s.x, q.x), 0, W),
        y0: clamp(Math.min(s.y, q.y), 0, H), y1: clamp(Math.max(s.y, q.y), 0, H),
      };
    }
    render();
  });

  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size > 0) {
      // Lifting one finger of a pinch: ignore the remaining one until it is lifted too.
      if (gesture?.mode === "pinch") gesture = { mode: "wait" };
      return;
    }
    box.classList.remove("active");
    const wasPinch = gesture?.mode === "pinch" || gesture?.mode === "wait";
    const changed = gesture?.before && JSON.stringify(gesture.before) !== JSON.stringify(crop);
    gesture = null;
    if (changed || (wasPinch && view.k < minK())) refit();
  };
  on(area, "pointerup", release);
  on(area, "pointercancel", release);

  on(area, "wheel", (e) => {
    e.preventDefault();
    cancelAnimationFrame(anim);
    const p = local(e);
    const kLo = minK();
    const k = clamp(view.k * Math.exp(-e.deltaY / 300), kLo, Math.max(kLo, MAX_K) * 1.5);
    view.tx = p.x - ((p.x - view.tx) / view.k) * k;
    view.ty = p.y - ((p.y - view.ty) / view.k) * k;
    view.k = k;
    render();
  }, { passive: false });

  on(window, "resize", () => refit(false));

  on(resetBtn, "click", () => {
    crop = { x0: 0, y0: 0, x1: W, y1: H };
    refit();
  });

  return new Promise((resolve) => {
    function close(result) {
      ac.abort();
      cancelAnimationFrame(anim);
      root.hidden = true;
      document.body.style.overflow = "";
      resolve(result);
    }

    on(cancelBtn, "click", () => close(null));

    on(goBtn, "click", () => {
      const x0 = Math.round(crop.x0);
      const y0 = Math.round(crop.y0);
      const w = Math.round(crop.x1) - x0;
      const h = Math.round(crop.y1) - y0;
      const scale = Math.min(1, OUT_SIDE / Math.max(w, h));
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * scale));
      out.height = Math.max(1, Math.round(h * scale));
      const ctx = out.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(photo, x0, y0, w, h, 0, 0, out.width, out.height);
      close(out.toDataURL("image/jpeg", 0.88));
    });
  });
}
