// Photo editor: the user paints over words with a highlighter, then the marked
// fragments are recognized on-device by Tesseract. Only the text leaves the phone.

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";
const OCR_LANGS = { en: "eng", de: "deu", fr: "fra", es: "spa", it: "ita", pt: "por", he: "heb", pl: "pol", zh: "chi_sim", ja: "jpn" };
const AUTO_LANGS = "eng+deu+fra+spa";
const MAX_SIDE = 2400;   // working photo size, px
const MARKER_PX = 26;    // marker thickness on screen, CSS px
const MAX_ZOOM = 8;
const OCR_LINE_PX = 80;  // marked line height we scale crops to before OCR

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- Tesseract ---------- */

let tesseractLoad = null;
function loadTesseract() {
  tesseractLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => {
      tesseractLoad = null;
      s.remove();
      reject(new Error("Не удалось загрузить распознавание. Проверь интернет."));
    };
    document.head.appendChild(s);
  });
  return tesseractLoad;
}

let workerReady = null;
let workerLangs = null;
let onProgress = null;

function getWorker(langs) {
  if (workerReady && workerLangs === langs) return workerReady;
  const prev = workerReady;
  workerLangs = langs;
  workerReady = (async () => {
    if (prev) {
      try { await (await prev).terminate(); } catch {}
    }
    const T = await loadTesseract();
    return T.createWorker(langs, 1, { logger: (m) => onProgress?.(m) });
  })();
  workerReady.catch(() => {
    workerReady = null;
    workerLangs = null;
  });
  return workerReady;
}

/* ---------- photo ---------- */

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

/* ---------- marked fragments ---------- */

// One box per stroke, padded so letters sticking out of the marker are kept
// (the round cap already reaches w/2 past each end, so padX stays modest);
// overlapping boxes are merged so a word painted in several passes is read once.
function fragments(strokes, W, H) {
  let boxes = strokes.map((st, order) => {
    const xs = st.pts.map((p) => p.x);
    const ys = st.pts.map((p) => p.y);
    const padX = st.w * 0.6;
    const padY = st.w * 0.9;
    return {
      x0: Math.min(...xs) - padX, x1: Math.max(...xs) + padX,
      y0: Math.min(...ys) - padY, y1: Math.max(...ys) + padY,
      lineW: st.w, order,
    };
  });

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
          boxes[i] = {
            x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
            y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
            lineW: Math.max(a.lineW, b.lineW), order: Math.min(a.order, b.order),
          };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  return boxes
    .map((b) => ({
      ...b,
      x0: Math.round(clamp(b.x0, 0, W)), x1: Math.round(clamp(b.x1, 0, W)),
      y0: Math.round(clamp(b.y0, 0, H)), y1: Math.round(clamp(b.y1, 0, H)),
    }))
    .filter((b) => b.x1 - b.x0 > 4 && b.y1 - b.y0 > 4)
    .sort((a, b) => a.order - b.order);
}

async function recognizeBox(worker, photo, b) {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const scale = clamp(OCR_LINE_PX / b.lineW, 0.5, 4);
  const margin = 16;
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale) + margin * 2;
  c.height = Math.round(h * scale) + margin * 2;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, b.x0, b.y0, w, h, margin, margin, w * scale, h * scale);

  const singleLine = h / b.lineW < 2.6;
  await worker.setParameters({ tessedit_pageseg_mode: singleLine ? "7" : "6" });
  const { data } = await worker.recognize(c);
  // Drop junk from letters clipped at the edges of the box: short letterless tokens.
  const words = data.text.split(/\s+/).filter(Boolean);
  while (words.length > 1 && /^[^\p{L}]{1,2}$/u.test(words[0])) words.shift();
  while (words.length > 1 && /^[^\p{L}]{1,2}$/u.test(words[words.length - 1])) words.pop();
  return words
    .join(" ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.!?)]+$/gu, "")
    .trim();
}

/* ---------- editor ---------- */

// Opens the editor for a photo file. Resolves with the recognized text,
// or null if the user cancels.
export async function openMarker(file, studyLang) {
  const photo = await loadPhoto(file);
  const W = photo.width;
  const H = photo.height;
  const langs = OCR_LANGS[studyLang] ?? AUTO_LANGS;

  const root = $("#marker");
  const area = $("#marker-area");
  const stage = $("#marker-stage");
  const photoCanvas = $("#marker-photo");
  const ink = $("#marker-ink");
  const status = $("#marker-status");
  const undoBtn = $("#marker-undo");
  const goBtn = $("#marker-go");
  const cancelBtn = $("#marker-cancel");

  photoCanvas.width = ink.width = W;
  photoCanvas.height = ink.height = H;
  photoCanvas.getContext("2d").drawImage(photo, 0, 0);
  const ctx = ink.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = ctx.fillStyle = "#ffd400";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const defaultStatus = "Двумя пальцами — увеличить и подвинуть";
  const setStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle("error", isError);
  };
  setStatus(defaultStatus);

  root.hidden = false;
  document.body.style.overflow = "hidden";

  // Start downloading the OCR engine while the user is marking.
  getWorker(langs).catch(() => {});

  /* layout & zoom */
  let fit = 1;
  const view = { s: 1, tx: 0, ty: 0 };

  function apply() {
    stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
  }
  function layout() {
    const r = area.getBoundingClientRect();
    fit = Math.min(r.width / W, r.height / H);
    stage.style.width = `${W * fit}px`;
    stage.style.height = `${H * fit}px`;
    view.s = 1;
    view.tx = (r.width - W * fit) / 2;
    view.ty = (r.height - H * fit) / 2;
    apply();
  }
  layout();

  function local(e) {
    const r = area.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toImage(p) {
    return { x: (p.x - view.tx) / view.s / fit, y: (p.y - view.ty) / view.s / fit };
  }
  function zoomAround(p, s) {
    const cx = (p.x - view.tx) / view.s;
    const cy = (p.y - view.ty) / view.s;
    view.s = clamp(s, 1, MAX_ZOOM);
    view.tx = p.x - cx * view.s;
    view.ty = p.y - cy * view.s;
    if (view.s <= 1.001) layout();
    else apply();
  }

  /* strokes */
  const strokes = [];
  let current = null;

  function dot(p, w) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  function redraw() {
    ctx.clearRect(0, 0, W, H);
    for (const st of strokes) {
      ctx.lineWidth = st.w;
      if (st.pts.length === 1) { dot(st.pts[0], st.w); continue; }
      ctx.beginPath();
      ctx.moveTo(st.pts[0].x, st.pts[0].y);
      for (const p of st.pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
  function syncButtons() {
    undoBtn.disabled = strokes.length === 0;
    goBtn.disabled = strokes.length === 0;
  }

  /* gestures: one finger paints, two fingers zoom and pan */
  const pointers = new Map();
  let mode = "idle";
  let pinch = null;
  let busy = false;
  const ac = new AbortController();
  const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal: ac.signal });

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      s0: view.s, tx0: view.tx, ty0: view.ty,
    };
  }

  on(area, "pointerdown", (e) => {
    if (busy) return;
    e.preventDefault();
    area.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      mode = "draw";
      const p = toImage(local(e));
      current = { w: MARKER_PX / (view.s * fit), pts: [p] };
      strokes.push(current);
      ctx.lineWidth = current.w;
      dot(p, current.w);
    } else if (pointers.size === 2) {
      // The second finger turns a just-started stroke into a pinch.
      if (mode === "draw" && current) {
        strokes.pop();
        current = null;
        redraw();
      }
      mode = "pinch";
      startPinch();
    }
    syncButtons();
  });

  on(area, "pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (mode === "draw" && current) {
      const p = toImage(local(e));
      const last = current.pts[current.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
      current.pts.push(p);
      ctx.lineWidth = current.w;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else if (mode === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clamp(pinch.s0 * (d / pinch.d0), 1, MAX_ZOOM);
      const cx = (pinch.m0.x - pinch.tx0) / pinch.s0;
      const cy = (pinch.m0.y - pinch.ty0) / pinch.s0;
      view.s = s;
      view.tx = m.x - cx * s;
      view.ty = m.y - cy * s;
      apply();
    }
  });

  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (mode === "draw") current = null;
    if (mode === "pinch" && pointers.size < 2 && view.s <= 1.001) layout();
    // After a pinch the remaining finger does nothing until it is lifted too.
    if (pointers.size === 0) mode = "idle";
    else if (mode === "pinch" && pointers.size < 2) mode = "wait";
    syncButtons();
  };
  on(area, "pointerup", release);
  on(area, "pointercancel", release);

  on(area, "wheel", (e) => {
    e.preventDefault();
    zoomAround(local(e), view.s * Math.exp(-e.deltaY / 300));
  }, { passive: false });
  on(window, "resize", layout);

  on(undoBtn, "click", () => {
    strokes.pop();
    redraw();
    syncButtons();
  });

  return new Promise((resolve) => {
    function close(result) {
      ac.abort();
      onProgress = null;
      root.hidden = true;
      document.body.style.overflow = "";
      resolve(result);
    }

    on(cancelBtn, "click", () => close(null));

    on(goBtn, "click", async () => {
      const boxes = fragments(strokes, W, H);
      if (!boxes.length) return;
      busy = true;
      goBtn.disabled = undoBtn.disabled = true;
      onProgress = (m) => {
        const pct = m.progress ? ` ${Math.round(m.progress * 100)}%` : "";
        if (m.status === "recognizing text") setStatus(`Распознаю…${pct}`);
        else if (/load/i.test(m.status)) setStatus(`Загружаю распознавание (только в первый раз)…${pct}`);
      };
      setStatus("Готовлю распознавание…");
      try {
        const worker = await getWorker(langs);
        const parts = [];
        for (const b of boxes) {
          const text = await recognizeBox(worker, photo, b);
          if (text) parts.push(text);
        }
        if (!parts.length) {
          setStatus("Ничего не прочиталось. Увеличь фото и проведи по слову ещё раз.", true);
          return;
        }
        close(parts.join("\n"));
      } catch (err) {
        setStatus(err.message || String(err), true);
      } finally {
        busy = false;
        syncButtons();
      }
    });
  });
}
