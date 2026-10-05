import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Collage editor shown directly on the "Image Collage" node.
// The arrangement is stored as JSON in the (hidden) `canvas_state` widget and
// composited again on the Python side (collage.py) when the graph runs.
// Item coordinates are output pixels; a 1x1 grid is the free layout where any
// number of images can be placed on the whole canvas.

const NODE_ID = "ImageCanvasMini_ImageCollage";
const STATE_WIDGET = "canvas_state";
const UPLOAD_SUBFOLDER = "imagecanvas_mini";

const DEFAULT_SIZE = 1024;
const MIN_SIZE = 16;       // must match collage.py
const MAX_SIZE = 8192;
const MAX_VIEW_PX = 2048;  // the editing canvas is drawn at most this large
const V1_CELL = 512;       // cell size of the first state format
const HANDLE_PX = 10;      // resize handle size in screen pixels
const MIN_IMG = 20;
const MIN_HEIGHT = 320;
const FREE_ADD_FRACTION = 0.6;
const MARGIN_RATIO = 0.2;  // work area around the output frame, relative to its longer side
const GHOST_ALPHA = 0.3;   // opacity of image parts outside the output (not saved)
const GRIDS = [
  { cols: 1, rows: 1, label: "1×1" },
  { cols: 2, rows: 1, label: "1×2" },
  { cols: 1, rows: 2, label: "2×1" },
  { cols: 2, rows: 2, label: "2×2" },
  { cols: 1, rows: 4, label: "4×1" },
  { cols: 4, rows: 1, label: "1×4" },
];
const ASPECTS = ["1:1", "4:3", "3:2", "16:9", "21:9", "3:4", "2:3", "9:16"];

const STYLE_ID = "icm-collage-style";
const STYLE = `
.icm-root { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; box-sizing: border-box; font-family: sans-serif; }
.icm-toolbar { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; padding: 4px; background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 4px 4px 0 0; }
.icm-group { display: flex; gap: 3px; align-items: center; }
.icm-label { font-size: 11px; color: #c4b5fd; white-space: nowrap; }
.icm-sep { width: 1px; height: 18px; background: #3a3a4a; }
.icm-btn { padding: 2px 7px; font-size: 11px; line-height: 1.4; background: #2a2a3a; border: 1px solid #4a4a5a; border-radius: 4px; color: #d1d5db; cursor: pointer; white-space: nowrap; }
.icm-btn:hover { background: #3a3a4a; }
.icm-btn.active { background: #7c3aed; border-color: #7c3aed; color: #fff; }
.icm-btn.primary { background: #065f46; border-color: #10b981; color: #d1fae5; }
.icm-btn.primary:hover { background: #047857; }
.icm-btn[hidden], .icm-input[hidden] { display: none; }
.icm-input { box-sizing: border-box; height: 20px; padding: 0 4px; font-size: 11px; background: #12121a; border: 1px solid #4a4a5a; border-radius: 4px; color: #e5e7eb; }
.icm-input.num { width: 52px; }
.icm-input.hex { width: 62px; }
.icm-input.ratio { width: 52px; }
.icm-input.invalid { border-color: #ef4444; }
.icm-color { width: 24px; height: 20px; padding: 0; background: none; border: 1px solid #4a4a5a; border-radius: 4px; cursor: pointer; }
.icm-check { font-size: 11px; color: #c4b5fd; cursor: pointer; display: flex; align-items: center; gap: 3px; white-space: nowrap; }
.icm-check input { margin: 0; }
.icm-check.disabled { opacity: 0.45; cursor: default; }
.icm-area { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #12121a; border: 1px solid #2a2a3a; border-top: none; }
.icm-area.dragover { outline: 2px dashed #a78bfa; outline-offset: -2px; }
.icm-canvas { display: block; touch-action: none; cursor: default; outline: none; }
.icm-status { flex: 0 0 auto; padding: 2px 4px; font-size: 10px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #1a1a24; border: 1px solid #2a2a3a; border-top: none; border-radius: 0 0 4px 4px; }
.icm-status.error { color: #fca5a5; }
`;
const HINT = "Drop images · Drag: move · Corners: resize · Del: remove · Ctrl+drag: frame (1×1)";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, onClick, className) {
  const btn = el("button", "icm-btn" + (className ? " " + className : ""), label);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

function hasFiles(e) {
  return Array.from(e?.dataTransfer?.types || []).includes("Files");
}

function imageFiles(fileList) {
  return Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
}

function clampSize(value, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
}

// "16:9", "16/9", "16x9" or "1.78" -> width/height ratio, or null.
function parseAspect(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[:\/x×]\s*(\d+(?:\.\d+)?))?\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const ratio = m[2] === undefined ? Number(m[1]) : Number(m[1]) / Number(m[2]);
  return Number.isFinite(ratio) && ratio >= 0.05 && ratio <= 20 ? ratio : null;
}

// "#abc" / "aabbcc" -> "#aabbcc", or null.
function parseColor(text) {
  const m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  return "#" + hex.toLowerCase();
}

function isDark(color) {
  const n = parseInt(color.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function viewUrl(name) {
  const slash = name.lastIndexOf("/");
  const params = new URLSearchParams({
    filename: slash >= 0 ? name.slice(slash + 1) : name,
    subfolder: slash >= 0 ? name.slice(0, slash) : "",
    type: "input",
  });
  return api.apiURL(`/view?${params}`);
}

async function uploadImage(file) {
  const body = new FormData();
  body.append("image", file);
  body.append("subfolder", UPLOAD_SUBFOLDER);
  body.append("type", "input");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (resp.status !== 200) throw new Error(`${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

function createEditor(node, stateWidget) {
  let W = DEFAULT_SIZE, H = DEFAULT_SIZE;   // output size = logical canvas size
  let aspect = "free";                      // "free" or a ratio string like "16:9"
  let cols = 2, rows = 2;
  let bgColor = "#000000";
  let border = true;
  // item: { image, img, cell, ix, iy, iw, ih, aspect, missing }  (img is null while loading / missing)
  // Drawn in array order, so the last item is on top.
  let items = [];
  let active = null;      // selected item
  let activeCell = -1;    // selected cell (grid layouts)
  let dragging = null;
  let resizing = null;
  let loadToken = 0;
  // Output frame editing (free layout only): the frame is moved / resized over
  // the images, which keep their place. While dragging, the view is frozen and
  // the frame sits at (originX, originY) inside it; on release it re-centers.
  let frameMode = false;  // "Adjust frame" toggle
  let ctrlHover = false;  // Ctrl held while hovering: same as the toggle
  let frameDrag = null;
  let frozen = null;      // { m, vw, vh } of the view while a frame drag is running
  let originX = 0, originY = 0;

  const isFree = () => cols * rows === 1;
  // The editing view is the output frame plus a margin on every side, so that
  // images (and their handles) reaching outside the frame stay workable.
  const margin = () => frozen ? frozen.m : Math.round(Math.max(W, H) * MARGIN_RATIO);
  const viewW = () => frozen ? frozen.vw : W + margin() * 2;
  const viewH = () => frozen ? frozen.vh : H + margin() * 2;

  // --- DOM ---
  const root = el("div", "icm-root");
  const toolbar = el("div", "icm-toolbar");
  const area = el("div", "icm-area");
  const canvas = el("canvas", "icm-canvas");
  canvas.tabIndex = 0;
  const status = el("div", "icm-status", HINT);
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.style.display = "none";
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files, null);
    fileInput.value = "";
  });

  function group(...children) {
    const g = el("div", "icm-group");
    g.append(...children);
    return g;
  }

  function textInput(className, title) {
    const input = el("input", "icm-input " + className);
    input.type = "text";
    input.spellcheck = false;
    if (title) input.title = title;
    // Keep ComfyUI's canvas shortcuts away from typing.
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
    });
    return input;
  }

  function checkbox(label, checked) {
    const wrap = el("label", "icm-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    wrap.append(input, label);
    return { wrap, input };
  }

  const gridButtons = GRIDS.map(g => button(g.label, () => setGrid(g.cols, g.rows)));
  gridButtons[0].title = "No grid: place any number of images freely";

  const widthInput = textInput("num", "Output width");
  const heightInput = textInput("num", "Output height");
  widthInput.inputMode = heightInput.inputMode = "numeric";
  widthInput.addEventListener("change", () => onSizeInput(true));
  heightInput.addEventListener("change", () => onSizeInput(false));

  const aspectSelect = el("select", "icm-input");
  aspectSelect.title = "Canvas aspect ratio";
  [["free", "Free"], ...ASPECTS.map(a => [a, a]), ["custom", "Custom"]].forEach(([value, label]) => {
    const opt = el("option", null, label);
    opt.value = value;
    aspectSelect.appendChild(opt);
  });
  const aspectInput = textInput("ratio", "Custom aspect ratio, e.g. 5:4 or 1.85");
  aspectInput.placeholder = "W:H";
  aspectSelect.addEventListener("change", onAspectSelect);
  aspectInput.addEventListener("change", onAspectCustom);

  const bgButtons = [["#000000", "Black"], ["#ffffff", "White"]].map(([color, label]) => {
    const btn = button(label, () => setBg(color));
    btn.dataset.bg = color;
    return btn;
  });
  const colorPicker = el("input", "icm-color");
  colorPicker.type = "color";
  colorPicker.title = "Pick background color";
  colorPicker.addEventListener("input", () => setBg(colorPicker.value));
  const colorInput = textInput("hex", "Background color code, e.g. #808080");
  colorInput.addEventListener("change", () => {
    const color = parseColor(colorInput.value);
    colorInput.classList.toggle("invalid", !color);
    if (color) setBg(color);
  });

  const keepRatio = checkbox("Lock image ratio", true);
  const borderCheck = checkbox("Border", true);
  keepRatio.input.addEventListener("change", saveState);
  borderCheck.input.addEventListener("change", () => {
    border = borderCheck.input.checked;
    commit();
  });

  const frameBtn = button("Adjust frame", () => {
    frameMode = !frameMode;
    syncToolbar();
    render();
  });
  frameBtn.title = "Move / resize the output frame over the images with the mouse (1×1 only). Holding Ctrl does the same.";
  const frontBtn = button("Front", () => reorder(true));
  const backBtn = button("Back", () => reorder(false));

  toolbar.append(
    group(el("span", "icm-label", "Grid:"), ...gridButtons),
    el("div", "icm-sep"),
    group(el("span", "icm-label", "Size:"), widthInput, el("span", "icm-label", "×"), heightInput),
    group(el("span", "icm-label", "Aspect:"), aspectSelect, aspectInput),
    el("div", "icm-sep"),
    group(el("span", "icm-label", "BG:"), ...bgButtons, colorPicker, colorInput),
    el("div", "icm-sep"),
    keepRatio.wrap, borderCheck.wrap,
    el("div", "icm-sep"),
    group(
      button("Load image", () => fileInput.click(), "primary"),
      button("Remove", removeActive),
      button("Clear all", clearAll),
      frontBtn, backBtn, frameBtn,
    ),
  );
  area.appendChild(canvas);
  root.append(toolbar, area, status, fileInput);

  function setStatus(text, isError) {
    status.textContent = text || HINT;
    status.classList.toggle("error", !!isError);
  }

  function syncToolbar() {
    GRIDS.forEach((g, i) => gridButtons[i].classList.toggle("active", g.cols === cols && g.rows === rows));
    widthInput.value = W;
    heightInput.value = H;
    const preset = aspect === "free" || ASPECTS.includes(aspect);
    aspectSelect.value = preset ? aspect : "custom";
    aspectInput.hidden = preset;
    if (!preset) aspectInput.value = aspect;
    aspectInput.classList.remove("invalid");
    bgButtons.forEach(b => b.classList.toggle("active", b.dataset.bg === bgColor));
    colorPicker.value = bgColor;
    colorInput.value = bgColor;
    colorInput.classList.remove("invalid");
    borderCheck.input.checked = border;
    borderCheck.input.disabled = isFree();
    borderCheck.wrap.classList.toggle("disabled", isFree());
    frontBtn.hidden = backBtn.hidden = frameBtn.hidden = !isFree();
    if (!isFree()) frameMode = false;
    frameBtn.classList.toggle("active", frameMode);
  }

  // --- state <-> widget ---
  function saveState() {
    stateWidget.value = JSON.stringify({
      v: 2, width: W, height: H, aspect, cols, rows, bg: bgColor, border,
      keepRatio: keepRatio.input.checked,
      items: items.filter(it => it.image).map(it => ({
        image: it.image, cell: it.cell,
        x: round2(it.ix), y: round2(it.iy), w: round2(it.iw), h: round2(it.ih),
      })),
    });
    node.setDirtyCanvas?.(true, true);
  }

  function commit() {
    saveState();
    render();
  }

  function loadState(raw) {
    let state = {};
    try { state = raw ? JSON.parse(raw) : {}; } catch (_) { state = {}; }
    if (!state || typeof state !== "object") state = {};
    cols = Math.max(1, Math.min(8, parseInt(state.cols, 10) || 2));
    rows = Math.max(1, Math.min(8, parseInt(state.rows, 10) || 2));

    // First format: one image per cell, coordinates relative to 512px cells.
    const v1 = !Array.isArray(state.items) && Array.isArray(state.cells);
    let saved = Array.isArray(state.items) ? state.items : [];
    if (v1) {
      saved = state.cells.map((c, i) => c && { ...c, cell: i }).filter(Boolean);
      state.width = cols * V1_CELL;
      state.height = rows * V1_CELL;
    }

    W = clampSize(state.width, DEFAULT_SIZE);
    H = clampSize(state.height, DEFAULT_SIZE);
    aspect = (typeof state.aspect === "string" && parseAspect(state.aspect)) ? state.aspect : "free";
    bgColor = parseColor(state.bg) || "#000000";
    border = state.border !== false;
    keepRatio.input.checked = state.keepRatio !== false;
    active = null;
    activeCell = -1;
    dragging = resizing = null;

    const token = ++loadToken;
    items = saved
      .filter(s => s && s.image && Number.isInteger(s.cell) && s.cell >= 0 && s.cell < cols * rows)
      .map(s => {
        const item = { image: s.image, img: null, cell: s.cell, ix: +s.x || 0, iy: +s.y || 0, iw: +s.w || 100, ih: +s.h || 100 };
        item.aspect = item.iw / item.ih;
        loadImage(viewUrl(s.image)).then(img => {
          if (token !== loadToken) return;
          item.img = img;
          item.aspect = img.naturalWidth / img.naturalHeight;
          render();
        }).catch(() => {
          if (token !== loadToken) return;
          item.missing = true;
          render();
        });
        return item;
      });
    resizeCanvas();
    syncToolbar();
    if (v1) saveState();
    render();
  }

  // --- geometry ---
  function cellBounds(idx) {
    const cw = W / cols, ch = H / rows;
    return { cx: (idx % cols) * cw, cy: Math.floor(idx / cols) * ch, cw, ch };
  }

  // Grid cells are filled (cover); the free layout shows the whole image (contain).
  function fitItem(item, fraction, center) {
    const b = cellBounds(item.cell);
    const nw = item.img ? item.img.naturalWidth : item.aspect;
    const nh = item.img ? item.img.naturalHeight : 1;
    const scale = isFree()
      ? Math.min(b.cw / nw, b.ch / nh) * (fraction || 1)
      : Math.max(b.cw / nw, b.ch / nh);
    item.iw = nw * scale;
    item.ih = nh * scale;
    item.ix = (center ? center.x : b.cx + b.cw / 2) - item.iw / 2;
    item.iy = (center ? center.y : b.cy + b.ch / 2) - item.ih / 2;
  }

  function resizeCanvas() {
    const vs = Math.min(1, MAX_VIEW_PX / Math.max(viewW(), viewH()));
    canvas.width = Math.max(1, Math.round(viewW() * vs));
    canvas.height = Math.max(1, Math.round(viewH() * vs));
    fitCanvas();
  }

  // Scale the canvas element to fit the widget area, keeping the view aspect.
  function fitCanvas() {
    const aw = area.clientWidth, ah = area.clientHeight;
    if (!aw || !ah) return;
    const fit = Math.min(aw / viewW(), ah / viewH());
    canvas.style.width = Math.max(1, Math.floor(viewW() * fit)) + "px";
    canvas.style.height = Math.max(1, Math.floor(viewH() * fit)) + "px";
    render();
  }

  // Logical (output) pixels per screen pixel; the canvas is shown scaled on the node.
  function pxScale() {
    const r = canvas.getBoundingClientRect();
    return r.width ? viewW() / r.width : 1;
  }

  // Width an image of aspect `ar` gets when fitted to a cell (cover in a grid, contain when free).
  function fitWidth(ar, b) {
    return isFree() ? Math.min(b.cw, b.ch * ar) : Math.max(b.cw, b.ch * ar);
  }

  // Resize the output canvas. Each item keeps its zoom relative to the fitted
  // size and its offset relative to its cell, so a fitted image stays fitted.
  function setCanvasSize(nw, nh) {
    nw = clampSize(nw, W);
    nh = clampSize(nh, H);
    if (nw !== W || nh !== H) {
      const placed = items.map(it => {
        const b = cellBounds(it.cell);
        const ar = it.iw / it.ih;
        return {
          it, ar,
          zoom: it.iw / fitWidth(ar, b),
          ox: (it.ix + it.iw / 2 - b.cx) / b.cw,
          oy: (it.iy + it.ih / 2 - b.cy) / b.ch,
        };
      });
      W = nw; H = nh;
      for (const { it, ar, zoom, ox, oy } of placed) {
        const b = cellBounds(it.cell);
        it.iw = fitWidth(ar, b) * zoom;
        it.ih = it.iw / ar;
        it.ix = b.cx + ox * b.cw - it.iw / 2;
        it.iy = b.cy + oy * b.ch - it.ih / 2;
      }
      resizeCanvas();
    }
    syncToolbar();
    commit();
  }

  function onSizeInput(widthChanged) {
    const ratio = aspect === "free" ? null : parseAspect(aspect);
    let nw = clampSize(widthInput.value, W);
    let nh = clampSize(heightInput.value, H);
    if (ratio) {
      // The edited side wins; the other follows the fixed aspect.
      if (widthChanged) nh = clampSize(nw / ratio, H);
      else nw = clampSize(nh * ratio, W);
    }
    setCanvasSize(nw, nh);
  }

  function applyAspect(value) {
    aspect = value;
    const ratio = aspect === "free" ? null : parseAspect(aspect);
    setCanvasSize(W, ratio ? W / ratio : H);
  }

  function onAspectSelect() {
    if (aspectSelect.value !== "custom") return applyAspect(aspectSelect.value);
    // Start from the current canvas shape and let the user edit it.
    applyAspect(`${W}:${H}`);
    aspectInput.focus();
    aspectInput.select();
  }

  function onAspectCustom() {
    const ok = parseAspect(aspectInput.value) !== null;
    aspectInput.classList.toggle("invalid", !ok);
    if (ok) applyAspect(aspectInput.value.trim());
  }

  function setBg(color) {
    bgColor = color;
    syncToolbar();
    commit();
  }

  function setGrid(c, r) {
    if (c === cols && r === rows) return;
    const wasFree = isFree();
    cols = c; rows = r;
    const n = cols * rows;
    if (n === 1) {
      // To the free layout: keep every image where it is.
      items.forEach(it => { it.cell = 0; });
    } else {
      if (wasFree) {
        items = items.slice(0, n);
        items.forEach((it, i) => { it.cell = i; });
      } else {
        items = items.filter(it => it.cell < n);
      }
      items.forEach(it => fitItem(it));
    }
    if (!items.includes(active)) active = null;
    activeCell = active && !isFree() ? active.cell : -1;
    syncToolbar();
    commit();
  }

  // --- drawing ---
  function render() {
    const ctx = canvas.getContext("2d");
    const vs = canvas.width / viewW();
    const m = margin();
    const s = pxScale();
    const dark = isDark(bgColor);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Origin = top-left of the output frame; the margin lies at negative coordinates.
    ctx.setTransform(vs, 0, 0, vs, (m + originX) * vs, (m + originY) * vs);

    // Whole images, faint: whatever stays visible outside the frame is not saved.
    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    for (const it of items) {
      if (it.img) ctx.drawImage(it.img, it.ix, it.iy, it.iw, it.ih);
    }
    ctx.restore();

    // The output frame, exactly as it will be composited.
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    for (const it of items) {
      if (!it.img) continue;
      const b = cellBounds(it.cell);
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.cx, b.cy, b.cw, b.ch);
      ctx.clip();
      ctx.drawImage(it.img, it.ix, it.iy, it.iw, it.ih);
      ctx.restore();
    }

    if (border && !isFree()) {
      const bw = Math.max(2, Math.round(Math.min(W, H) / 256));
      ctx.strokeStyle = dark ? "#ffffff" : "#000000";
      ctx.lineWidth = bw;
      ctx.strokeRect(bw / 2, bw / 2, W - bw, H - bw);
      for (let c = 1; c < cols; c++) {
        ctx.beginPath();
        ctx.moveTo(c * W / cols, 0);
        ctx.lineTo(c * W / cols, H);
        ctx.stroke();
      }
      for (let r = 1; r < rows; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * H / rows);
        ctx.lineTo(W, r * H / rows);
        ctx.stroke();
      }
    }

    // Editing overlays below are not part of the output.
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = Math.max(1, s);
    ctx.setLineDash([4 * s, 3 * s]);
    ctx.strokeRect(-s / 2, -s / 2, W + s, H + s);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = 10 * s + "px sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText(`Output ${W}×${H}`, 0, -3 * s);
    ctx.restore();
    const hintColor = dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)";
    function label(text, x, y, w, h) {
      ctx.save();
      ctx.fillStyle = hintColor;
      ctx.font = Math.max(10 * s, Math.min(w * 0.12, h * 0.25, 28 * s)) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + w / 2, y + h / 2);
      ctx.restore();
    }
    for (let i = 0; i < cols * rows; i++) {
      if (items.some(it => it.cell === i)) continue;
      const b = cellBounds(i);
      label("Drop image", b.cx, b.cy, b.cw, b.ch);
    }
    for (const it of items) {
      if (it.img) continue;
      ctx.save();
      ctx.strokeStyle = hintColor;
      ctx.lineWidth = Math.max(1, s);
      ctx.setLineDash([4 * s, 4 * s]);
      ctx.strokeRect(it.ix, it.iy, it.iw, it.ih);
      ctx.restore();
      label(it.missing ? "Missing image" : "Loading…", it.ix, it.iy, it.iw, it.ih);
    }

    if (isFree() && (frameMode || ctrlHover || frameDrag)) {
      // Frame editing: solid outline with corner and edge handles.
      const hs = HANDLE_PX * s;
      ctx.save();
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = Math.max(1, 2 * s);
      ctx.strokeRect(0, 0, W, H);
      ctx.fillStyle = "#fbbf24";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = Math.max(1, s);
      for (const x of [0, W / 2, W]) {
        for (const y of [0, H / 2, H]) {
          if (x === W / 2 && y === H / 2) continue;
          ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
          ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
        }
      }
      ctx.restore();
      return;
    }

    if (activeCell >= 0 && !isFree()) {
      const b = cellBounds(activeCell);
      const lw = Math.max(1, 2 * s);
      ctx.save();
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = lw;
      ctx.setLineDash([5 * s, 3 * s]);
      ctx.strokeRect(b.cx + lw, b.cy + lw, b.cw - lw * 2, b.ch - lw * 2);
      ctx.restore();
    }
    if (active) {
      const hs = HANDLE_PX * s;
      ctx.save();
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(active.ix, active.iy, active.iw, active.ih);
      ctx.fillStyle = "#a78bfa";
      ctx.strokeStyle = "#fff";
      corners(active).forEach(c => {
        ctx.fillRect(c.x - hs / 2, c.y - hs / 2, hs, hs);
        ctx.strokeRect(c.x - hs / 2, c.y - hs / 2, hs, hs);
      });
      ctx.restore();
    }
  }

  // --- hit testing ---
  function corners(item) {
    return [
      { x: item.ix, y: item.iy, name: "tl" },
      { x: item.ix + item.iw, y: item.iy, name: "tr" },
      { x: item.ix, y: item.iy + item.ih, name: "bl" },
      { x: item.ix + item.iw, y: item.iy + item.ih, name: "br" },
    ];
  }

  function getCoords(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (viewW() / r.width) - margin() - originX,
      y: (e.clientY - r.top) * (viewH() / r.height) - margin() - originY,
    };
  }

  // --- output frame editing ---
  // Which part of the frame is under the pointer: an edge/corner ("l", "tr", ...),
  // "move" inside the frame, or null outside.
  function hitFrame(p) {
    const tol = HANDLE_PX * pxScale() * 0.8;
    if (p.x < -tol || p.y < -tol || p.x > W + tol || p.y > H + tol) return null;
    const kind =
      (Math.abs(p.y) <= tol ? "t" : Math.abs(p.y - H) <= tol ? "b" : "") +
      (Math.abs(p.x) <= tol ? "l" : Math.abs(p.x - W) <= tol ? "r" : "");
    return kind || "move";
  }

  function frameCursor(kind) {
    if (!kind) return "default";
    if (kind === "move") return "move";
    if (kind === "tl" || kind === "br") return "nwse-resize";
    if (kind === "tr" || kind === "bl") return "nesw-resize";
    return kind === "l" || kind === "r" ? "ew-resize" : "ns-resize";
  }

  // New frame rect, in the coordinates of the frame as it was when the drag began.
  function draggedFrame(fd, p) {
    const dx = p.x - fd.start.x, dy = p.y - fd.start.y;
    const k = fd.kind;
    if (k === "move") return { x: Math.round(dx), y: Math.round(dy), w: fd.W, h: fd.H };
    const left = k.includes("l"), right = k.includes("r"), top = k.includes("t"), bottom = k.includes("b");
    let w = clampSize(fd.W + (right ? dx : left ? -dx : 0), fd.W);
    let h = clampSize(fd.H + (bottom ? dy : top ? -dy : 0), fd.H);
    const ratio = aspect === "free" ? null : parseAspect(aspect);
    if (ratio) {
      // Fixed aspect: the dragged width (or height, for top/bottom edges) leads.
      if (left || right) {
        h = clampSize(w / ratio, fd.H);
        w = clampSize(h * ratio, fd.W);
      } else {
        w = clampSize(h * ratio, fd.W);
        h = clampSize(w / ratio, fd.H);
      }
    }
    // The side opposite to the dragged one stays put; an axis that only follows
    // the aspect grows around its center.
    const x = left ? fd.W - w : right ? 0 : (fd.W - w) / 2;
    const y = top ? fd.H - h : bottom ? 0 : (fd.H - h) / 2;
    return { x: Math.round(x), y: Math.round(y), w, h };
  }

  function startFrameDrag(kind, p) {
    frozen = { m: margin(), vw: viewW(), vh: viewH() };
    frameDrag = { kind, start: p, W, H, items: items.map(it => ({ it, ix: it.ix, iy: it.iy })) };
  }

  function updateFrameDrag(e) {
    const c = getCoords(e);
    const r = draggedFrame(frameDrag, { x: c.x + originX, y: c.y + originY });
    W = r.w; H = r.h;
    originX = r.x; originY = r.y;
    for (const o of frameDrag.items) {
      o.it.ix = o.ix - r.x;
      o.it.iy = o.iy - r.y;
    }
    widthInput.value = W;
    heightInput.value = H;
    render();
  }

  function endFrameDrag() {
    frameDrag = null;
    frozen = null;
    originX = originY = 0;
    resizeCanvas();
    syncToolbar();
    commit();
  }

  function hitCell(p) {
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return -1;
    const c = Math.min(cols - 1, Math.floor(p.x / (W / cols)));
    const r = Math.min(rows - 1, Math.floor(p.y / (H / rows)));
    return r * cols + c;
  }

  function hitCorner(item, p) {
    if (!item) return null;
    const hs = HANDLE_PX * pxScale() * 0.8;
    for (const c of corners(item)) {
      if (Math.abs(p.x - c.x) <= hs && Math.abs(p.y - c.y) <= hs) return c.name;
    }
    return null;
  }

  function insideItem(item, p) {
    return !!item &&
      p.x >= item.ix && p.x <= item.ix + item.iw &&
      p.y >= item.iy && p.y <= item.iy + item.ih;
  }

  // Topmost item under the pointer. Inside a grid only the item of the cell
  // under the pointer counts; in the margin any item reaching out there does.
  function hitItem(p) {
    const cell = hitCell(p);
    if (cell >= 0 && !isFree()) {
      const item = itemInCell(cell);
      return insideItem(item, p) ? item : null;
    }
    if (cell < 0 && insideItem(active, p)) return active;
    for (let i = items.length - 1; i >= 0; i--) {
      if (insideItem(items[i], p)) return items[i];
    }
    return null;
  }

  function itemInCell(idx) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].cell === idx) return items[i];
    }
    return null;
  }

  // --- adding / removing images ---
  function placeImage(img, image, cell, point, offset) {
    const item = { image, img, aspect: img.naturalWidth / img.naturalHeight };
    if (isFree()) {
      // First image fills the canvas (letterboxed); later ones are added smaller.
      item.cell = 0;
      const first = items.length === 0;
      const b = cellBounds(0);
      const center = point || { x: b.cw / 2, y: b.ch / 2 };
      fitItem(item, first ? 1 : FREE_ADD_FRACTION, first ? null : { x: center.x + offset, y: center.y + offset });
    } else {
      item.cell = Math.min(cell, cols * rows - 1);
      items = items.filter(it => it.cell !== item.cell);
      fitItem(item);
      activeCell = item.cell;
    }
    items.push(item);
    active = item;
    commit();
  }

  // target: { cell, point } from a drop on the canvas, or null (button / drop elsewhere).
  // In a grid the first file goes to the target cell and the rest fill empty cells.
  async function addFiles(files, target) {
    files = imageFiles(files);
    if (!files.length) return;
    const n = cols * rows;
    let cell = target ? target.cell : (activeCell >= 0 ? activeCell : -1);
    if (cell < 0 || cell >= n) {
      cell = [...Array(n).keys()].find(i => !itemInCell(i)) ?? 0;
    }
    const cellsToFill = [cell];
    for (let k = 1; k < n; k++) {
      const i = (cell + k) % n;
      if (!itemInCell(i)) cellsToFill.push(i);
    }
    const step = 24 * pxScale();
    for (let k = 0; k < files.length; k++) {
      if (!isFree() && k >= cellsToFill.length) break;
      const file = files[k];
      const url = URL.createObjectURL(file);
      try {
        setStatus(`Uploading ${file.name}…`);
        const [image, img] = await Promise.all([uploadImage(file), loadImage(url)]);
        placeImage(img, image, cellsToFill[Math.min(k, cellsToFill.length - 1)], target?.point, k * step);
        setStatus("");
      } catch (err) {
        setStatus(`Failed to add ${file.name}: ${err.message || err}`, true);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  function removeActive() {
    const item = active || (activeCell >= 0 ? itemInCell(activeCell) : null);
    if (!item) return;
    items = items.filter(it => it !== item);
    active = null;
    commit();
  }

  function clearAll() {
    if (!items.length) return;
    if (!confirm("Remove all images?")) return;
    items = [];
    active = null;
    activeCell = -1;
    commit();
  }

  function reorder(toFront) {
    if (!active) return;
    items = items.filter(it => it !== active);
    if (toFront) items.push(active); else items.unshift(active);
    commit();
  }

  // --- pointer events ---
  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const p = getCoords(e);
    e.preventDefault();
    canvas.focus({ preventScroll: true });

    if (isFree() && (frameMode || e.ctrlKey || e.metaKey)) {
      const kind = hitFrame(p);
      if (kind) {
        startFrameDrag(kind, p);
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        render();
      }
      return;
    }

    const corner = hitCorner(active, p);
    if (corner) {
      resizing = {
        startX: p.x, startY: p.y,
        origX: active.ix, origY: active.iy, origW: active.iw, origH: active.ih,
        aspect: active.aspect, corner,
      };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }

    const hit = hitItem(p);
    const cell = hitCell(p);
    if (isFree()) {
      active = hit;
      activeCell = -1;
    } else if (cell >= 0) {
      activeCell = cell;
      active = itemInCell(cell);
    } else {
      // In the margin: grab an image by the part that reaches outside the frame.
      active = hit;
      activeCell = hit ? hit.cell : -1;
    }
    if (hit) {
      dragging = { startX: p.x, startY: p.y, origX: hit.ix, origY: hit.iy };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    render();
  });

  canvas.addEventListener("pointermove", e => {
    if (frameDrag) {
      e.preventDefault();
      updateFrameDrag(e);
      return;
    }
    const p = getCoords(e);
    const ctrl = isFree() && !dragging && !resizing && (e.ctrlKey || e.metaKey);
    if (ctrl !== ctrlHover) {
      ctrlHover = ctrl;
      render();
    }
    if (isFree() && (frameMode || ctrl) && !dragging && !resizing) {
      canvas.style.cursor = frameCursor(hitFrame(p));
      return;
    }
    if (dragging) {
      e.preventDefault();
      if (!active) return;
      active.ix = dragging.origX + (p.x - dragging.startX);
      active.iy = dragging.origY + (p.y - dragging.startY);
      render();
      return;
    }
    if (resizing) {
      e.preventDefault();
      if (!active) return;
      const dx = p.x - resizing.startX;
      const dy = p.y - resizing.startY;
      const keep = keepRatio.input.checked;
      const ratio = resizing.aspect;
      const min = MIN_IMG * pxScale();
      let nx = resizing.origX, ny = resizing.origY;
      let nw = resizing.origW, nh = resizing.origH;
      const cn = resizing.corner;
      if (cn === "br") {
        nw = Math.max(min, resizing.origW + dx);
        nh = keep ? nw / ratio : Math.max(min, resizing.origH + dy);
      } else if (cn === "bl") {
        nw = Math.max(min, resizing.origW - dx);
        nh = keep ? nw / ratio : Math.max(min, resizing.origH + dy);
        nx = resizing.origX + resizing.origW - nw;
      } else if (cn === "tr") {
        nw = Math.max(min, resizing.origW + dx);
        nh = keep ? nw / ratio : Math.max(min, resizing.origH - dy);
        ny = resizing.origY + resizing.origH - nh;
      } else if (cn === "tl") {
        nw = Math.max(min, resizing.origW - dx);
        nh = keep ? nw / ratio : Math.max(min, resizing.origH - dy);
        nx = resizing.origX + resizing.origW - nw;
        ny = resizing.origY + resizing.origH - nh;
      }
      active.ix = nx; active.iy = ny; active.iw = nw; active.ih = nh;
      render();
      return;
    }

    const corner = hitCorner(active, p);
    if (corner) {
      canvas.style.cursor = (corner === "tl" || corner === "br") ? "nwse-resize" : "nesw-resize";
    } else {
      canvas.style.cursor = hitItem(p) ? "move" : "default";
    }
  });

  function endPointer(e) {
    if (frameDrag) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      endFrameDrag();
      return;
    }
    if (dragging || resizing) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      dragging = null;
      resizing = null;
      saveState();
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // Delete must not reach ComfyUI, which would remove the selected node.
  canvas.addEventListener("keydown", e => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    e.stopPropagation();
    removeActive();
  });

  // --- file drop (anywhere on the widget) ---
  root.addEventListener("dragover", e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    area.classList.add("dragover");
  });
  root.addEventListener("dragleave", () => area.classList.remove("dragover"));
  root.addEventListener("drop", e => {
    area.classList.remove("dragover");
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    let target = null;
    if (e.target === canvas) {
      const p = getCoords(e);
      const point = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
      target = { cell: hitCell(p), point };
    }
    addFiles(e.dataTransfer.files, target);
  });

  new ResizeObserver(fitCanvas).observe(area);

  loadState(stateWidget.value);
  return { root, loadState, addFiles };
}

app.registerExtension({
  name: "ImageCanvasMini.ImageCollage",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const stateWidget = this.widgets?.find(w => w.name === STATE_WIDGET);
      if (!stateWidget || typeof this.addDOMWidget !== "function") return result;

      // The state lives in a plain STRING widget so it is saved with the workflow.
      stateWidget.hidden = true;
      stateWidget.computeSize = () => [0, -4];

      ensureStyle();
      const editor = createEditor(this, stateWidget);
      this._icmCollage = editor;
      const widget = this.addDOMWidget("collage_editor", "icm_collage", editor.root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => MIN_HEIGHT,
      });
      widget.serialize = false;

      // Drops that land on the node outside the widget (e.g. the title bar).
      this.onDragOver = e => hasFiles(e);
      this.onDragDrop = e => {
        const files = imageFiles(e?.dataTransfer?.files);
        if (!files.length) return false;
        editor.addFiles(files, null);
        return true;
      };

      this.setSize([Math.max(this.size[0], 460), Math.max(this.size[1], 640)]);
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = onConfigure?.apply(this, arguments);
      const stateWidget = this.widgets?.find(w => w.name === STATE_WIDGET);
      if (!this._icmCollage || !stateWidget) return result;
      // Workflows saved while the node still had a `cell_size` widget in front.
      const values = info?.widgets_values;
      if (Array.isArray(values) && typeof values[0] === "number" && typeof values[1] === "string") {
        stateWidget.value = values[1];
      }
      this._icmCollage.loadState(stateWidget.value);
      return result;
    };
  },
});
