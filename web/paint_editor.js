// Paint editor: a full-screen modal for drawing on one image (pen / brush /
// airbrush / eraser / cover, rectangular copy & paste, loupe, undo).
// Ported from simple-image-edit-with-qwen's drawing editor.
//
// openPaintEditor({ img, width, height, bg, overlay }) -> Promise<{ blob, mode, empty } | null>
//   img:     image (or canvas) to draw on, or null for a blank canvas of width×height
//   bg:      fill color of the blank canvas (default white)
//   overlay: pass an object to edit a transparent drawing layer over `img` instead
//            of the image itself; `overlay.img` is the existing layer (or null).
//   Resolves with the PNG blob when the user saves ("composite" = image + lines,
//   "lines" = lines on a white background, "overlay" = the drawing layer alone,
//   `empty` true when nothing is drawn), or null when the editor is closed.

const COLORS = ["#000000", "#ffffff", "#ff0000", "#ff8800", "#ffff00", "#00cc00", "#0088ff", "#8800ff", "#ff00ff", "#884400"];
const SIZES = [1, 2, 4, 8, 14, 24, 64];
const TOOLS = [
  { id: "pen", label: "Pen", cursor: "crosshair" },
  { id: "brush", label: "Brush", cursor: "crosshair", title: "Pressure-sensitive line" },
  { id: "airbrush", label: "Air", cursor: "crosshair" },
  { id: "eraser", label: "Eraser", cursor: "cell", title: "Erase lines only (the image stays)" },
  { id: "overwrite", label: "Cover", cursor: "cell", title: "Paint over with white" },
  { id: "select", label: "Select", cursor: "default", title: "Drag a rectangle to copy, then Paste" },
];
const MAX_HISTORY = 30;
const MIN_PASTE = 10;
const LOUPE_ZOOM = 4, LOUPE_SIZE = 140, LOUPE_CANVAS = 280;

// Tool settings persist across openings (per page load).
let currentTool = "pen";
let currentColor = "#ff0000";
let lineWidth = 4;
let clipboard = null;  // canvas copied with Select

const STYLE_ID = "icm-paint-style";
const STYLE = `
.icmp-root { position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,0.95); display: flex; flex-direction: column; align-items: center; font-family: sans-serif; outline: none; }
.icmp-toolbar { width: 100%; box-sizing: border-box; padding: 6px 12px; background: #1a1a24; border-bottom: 1px solid #2a2a3a; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.icmp-group { display: flex; gap: 3px; align-items: center; }
.icmp-label { font-size: 11px; color: #c4b5fd; margin-right: 2px; white-space: nowrap; }
.icmp-sep { width: 1px; height: 24px; background: #3a3a4a; margin: 0 4px; }
.icmp-btn { padding: 3px 8px; font-size: 12px; background: #2a2a3a; border: 1px solid #4a4a5a; border-radius: 4px; color: #d1d5db; cursor: pointer; white-space: nowrap; }
.icmp-btn:hover { background: #3a3a4a; }
.icmp-btn.active { background: #7c3aed; border-color: #7c3aed; color: #fff; }
.icmp-btn.save { background: #065f46; border-color: #10b981; color: #d1fae5; }
.icmp-btn.save:hover { background: #047857; }
.icmp-btn.close { background: #7f1d1d; border-color: #ef4444; color: #fecaca; }
.icmp-btn.close:hover { background: #991b1b; }
.icmp-btn.paste { background: #1a1a3a; border-color: #6366f1; color: #a5b4fc; }
.icmp-btn:disabled { opacity: 0.45; cursor: default; }
.icmp-swatch { width: 20px; height: 20px; border-radius: 3px; border: 2px solid transparent; cursor: pointer; box-sizing: border-box; }
.icmp-swatch.active { border-color: #fff; }
.icmp-swatch:hover { border-color: #9ca3af; }
.icmp-picker { width: 24px; height: 20px; border: none; padding: 0; cursor: pointer; background: none; }
.icmp-size { padding: 1px 6px; font-size: 11px; background: #2a2a3a; border: 1px solid #4a4a5a; border-radius: 3px; color: #d1d5db; cursor: pointer; }
.icmp-size.active { background: #7c3aed; border-color: #7c3aed; color: #fff; }
.icmp-pastebar { display: none; padding: 3px 8px; background: #1a2a1a; border: 1px solid #10b981; border-radius: 4px; color: #d1fae5; font-size: 11px; align-items: center; gap: 6px; }
.icmp-pastebar.active { display: flex; }
.icmp-pastebar label { cursor: pointer; display: flex; align-items: center; gap: 3px; }
.icmp-status { font-size: 11px; color: #9ca3af; margin-left: auto; white-space: nowrap; }
.icmp-area { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: auto; width: 100%; }
.icmp-wrap { position: relative; display: inline-block; }
.icmp-bg { display: block; max-width: 95vw; max-height: calc(100vh - 80px); }
.icmp-draw { position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
.icmp-sel { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
.icmp-sel.active { pointer-events: auto; cursor: crosshair; touch-action: none; }
.icmp-sel.pasting { pointer-events: auto; cursor: move; touch-action: none; }
.icmp-menu { position: fixed; z-index: 10010; background: #1a1a2e; border: 1px solid #4a4a6a; border-radius: 6px; padding: 4px; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
.icmp-menu button { display: block; width: 100%; padding: 5px 14px; font-size: 12px; background: #2a2a3a; border: 1px solid #4a4a5a; border-radius: 3px; color: #d1d5db; cursor: pointer; text-align: left; margin: 2px 0; white-space: nowrap; }
.icmp-menu button:hover { background: #3a3a5a; }
.icmp-loupe { position: fixed; pointer-events: none; z-index: 10005; width: ${LOUPE_SIZE}px; height: ${LOUPE_SIZE}px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.6); box-shadow: 0 0 8px rgba(0,0,0,0.7); display: none; overflow: hidden; image-rendering: pixelated; }
.icmp-loupe canvas { display: block; width: 100%; height: 100%; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, className) {
  const btn = el("button", "icmp-btn" + (className ? " " + className : ""), label);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

const colorParse = document.createElement("canvas");
colorParse.width = colorParse.height = 1;
function parseColor(color) {
  const ctx = colorParse.getContext("2d");
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function airbrushSpray(ctx, x, y, radius, color, density) {
  const [r, g, b] = parseColor(color);
  for (let i = 0; i < density; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * radius;
    const alpha = (1 - dist / radius) * 0.3;
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.fillRect(x + Math.cos(angle) * dist - 0.5, y + Math.sin(angle) * dist - 0.5, 1, 1);
  }
}

export function openPaintEditor({ img = null, width = 1024, height = 1024, bg = "#ffffff", overlay = null } = {}) {
  ensureStyle();
  return new Promise(resolve => {
    const w = img ? (img.naturalWidth || img.width) : Math.max(1, Math.round(width));
    const h = img ? (img.naturalHeight || img.height) : Math.max(1, Math.round(height));

    // --- state ---
    let history = [];
    let drawing = false;
    let selecting = false, selStart = null, selEnd = null;
    let pasteMode = false, pasteX = 0, pasteY = 0, pasteW = 0, pasteH = 0;
    let pasteDrag = null, pasteResize = null;
    let dirty = false;

    // --- DOM ---
    const root = el("div", "icmp-root");
    root.tabIndex = -1;
    const toolbar = el("div", "icmp-toolbar");
    const area = el("div", "icmp-area");
    const wrap = el("div", "icmp-wrap");
    const bgCanvas = el("canvas", "icmp-bg");
    const drawCanvas = el("canvas", "icmp-draw");
    const selCanvas = el("canvas", "icmp-sel");
    bgCanvas.width = drawCanvas.width = selCanvas.width = w;
    bgCanvas.height = drawCanvas.height = selCanvas.height = h;
    const bgCtx = bgCanvas.getContext("2d");
    const ctx = drawCanvas.getContext("2d", { willReadFrequently: true });
    const selCtx = selCanvas.getContext("2d");
    if (img) {
      bgCtx.drawImage(img, 0, 0);
    } else {
      bgCtx.fillStyle = bg;
      bgCtx.fillRect(0, 0, w, h);
    }
    if (overlay?.img) ctx.drawImage(overlay.img, 0, 0, w, h);
    wrap.append(bgCanvas, drawCanvas, selCanvas);
    area.appendChild(wrap);

    const menu = el("div", "icmp-menu");
    const loupe = el("div", "icmp-loupe");
    const loupeCanvas = el("canvas");
    loupeCanvas.width = loupeCanvas.height = LOUPE_CANVAS;
    loupe.appendChild(loupeCanvas);

    // Tools
    const toolButtons = TOOLS.map(t => {
      const b = button(t.label, () => setTool(t.id));
      if (t.title) b.title = t.title;
      return b;
    });
    function setTool(id) {
      if (pasteMode) return;
      currentTool = id;
      TOOLS.forEach((t, i) => toolButtons[i].classList.toggle("active", t.id === id));
      drawCanvas.style.cursor = TOOLS.find(t => t.id === id).cursor;
      if (id === "select") {
        selCanvas.classList.add("active");
      } else {
        selCanvas.classList.remove("active");
        hideMenu();
        clearSel();
      }
    }

    // Colors
    const colorGroup = el("div", "icmp-group");
    colorGroup.appendChild(el("span", "icmp-label", "Color:"));
    const swatches = COLORS.map(color => {
      const sw = el("div", "icmp-swatch");
      sw.style.background = color;
      sw.title = color;
      sw.addEventListener("click", () => setColor(color));
      colorGroup.appendChild(sw);
      return sw;
    });
    const picker = el("input", "icmp-picker");
    picker.type = "color";
    picker.title = "Custom color";
    picker.addEventListener("input", () => setColor(picker.value));
    colorGroup.appendChild(picker);
    function setColor(color) {
      currentColor = color;
      picker.value = color;
      COLORS.forEach((c, i) => swatches[i].classList.toggle("active", c === color));
    }

    // Sizes
    const sizeGroup = el("div", "icmp-group");
    sizeGroup.appendChild(el("span", "icmp-label", "Size:"));
    const sizeButtons = SIZES.map(size => {
      const b = el("button", "icmp-size", String(size));
      b.type = "button";
      b.addEventListener("click", () => setSize(size));
      sizeGroup.appendChild(b);
      return b;
    });
    function setSize(size) {
      lineWidth = size;
      SIZES.forEach((s, i) => sizeButtons[i].classList.toggle("active", s === size));
    }

    // Actions
    const pasteBtn = button("Paste", startPaste, "paste");
    pasteBtn.title = "Paste the copied region (Select a rectangle first)";
    const undoBtn = button("Undo", undo);
    undoBtn.title = "Ctrl+Z";
    const clearBtn = button("Clear", () => {
      if (history.length <= 1 && !overlay?.img) return;
      ctx.clearRect(0, 0, w, h);
      dirty = true;
      pushHistory();
    });
    clearBtn.title = "Remove all lines";
    const saveBtn = overlay
      ? button("Save", () => finish("overlay"), "save")
      : button("Save (+bg)", () => finish("composite"), "save");
    saveBtn.title = overlay ? "Save the lines as a layer over the collage" : "Replace the image with image + lines";
    const linesBtn = button("Save (lines)", () => finish("lines"), "save");
    linesBtn.title = "Replace the image with the lines on a white background";
    linesBtn.hidden = !!overlay;
    const closeBtn = button("Close", () => close(), "close");
    closeBtn.title = "Esc";

    const pasteBar = el("div", "icmp-pastebar");
    const keepRatio = el("input");
    keepRatio.type = "checkbox";
    const keepLabel = el("label", null, " Lock ratio");
    keepLabel.prepend(keepRatio);
    pasteBar.append(
      el("span", null, "Drag to move, corners to resize"),
      keepLabel,
      button("Confirm", confirmPaste, "save"),
      button("Cancel", cancelPaste, "close"),
    );
    const status = el("div", "icmp-status", `${w}×${h}`);

    const toolGroup = el("div", "icmp-group");
    toolGroup.append(...toolButtons);
    const actionGroup = el("div", "icmp-group");
    actionGroup.append(pasteBtn, undoBtn, clearBtn, saveBtn, linesBtn, closeBtn);
    toolbar.append(
      toolGroup, el("div", "icmp-sep"),
      colorGroup, el("div", "icmp-sep"),
      sizeGroup, el("div", "icmp-sep"),
      actionGroup, pasteBar, status,
    );
    root.append(toolbar, area, menu, loupe);

    // --- coordinates ---
    function coords(e) {
      const r = drawCanvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (w / r.width), y: (e.clientY - r.top) * (h / r.height) };
    }

    // --- history ---
    function pushHistory() {
      if (history.length >= MAX_HISTORY) history.shift();
      history.push(ctx.getImageData(0, 0, w, h));
      syncButtons();
    }
    function undo() {
      if (history.length <= 1) return;
      history.pop();
      ctx.putImageData(history[history.length - 1], 0, 0);
      syncButtons();
    }
    function syncButtons() {
      undoBtn.disabled = history.length <= 1;
      pasteBtn.disabled = !clipboard || pasteMode;
    }

    // --- selection / copy ---
    function selRect() {
      if (!selStart || !selEnd) return null;
      return {
        x: Math.min(selStart.x, selEnd.x), y: Math.min(selStart.y, selEnd.y),
        w: Math.abs(selEnd.x - selStart.x), h: Math.abs(selEnd.y - selStart.y),
      };
    }
    function drawSelRect() {
      selCtx.clearRect(0, 0, w, h);
      const r = selRect();
      if (!r || r.w < 2 || r.h < 2) return;
      selCtx.save();
      selCtx.setLineDash([6, 4]);
      selCtx.strokeStyle = "#00ff88";
      selCtx.lineWidth = 2;
      selCtx.strokeRect(r.x, r.y, r.w, r.h);
      selCtx.restore();
    }
    function clearSel() {
      selCtx.clearRect(0, 0, w, h);
      selStart = selEnd = null;
    }
    function copyRegion(source) {
      const r = selRect();
      if (!r || r.w < 2 || r.h < 2) return;
      const tmp = document.createElement("canvas");
      tmp.width = Math.round(r.w);
      tmp.height = Math.round(r.h);
      const t = tmp.getContext("2d");
      const sx = Math.round(r.x), sy = Math.round(r.y);
      if (source !== "draw") t.drawImage(bgCanvas, sx, sy, tmp.width, tmp.height, 0, 0, tmp.width, tmp.height);
      if (source !== "bg") t.drawImage(drawCanvas, sx, sy, tmp.width, tmp.height, 0, 0, tmp.width, tmp.height);
      clipboard = tmp;
      hideMenu();
      clearSel();
      syncButtons();
    }
    menu.append(
      button("Copy image + lines", () => copyRegion("both")),
      button("Copy image only", () => copyRegion("bg")),
      button("Copy lines only", () => copyRegion("draw")),
    );
    function showMenu() {
      const r = selRect();
      if (!r) return;
      const rect = selCanvas.getBoundingClientRect();
      const sx = rect.width / w, sy = rect.height / h;
      let mx = rect.left + (r.x + r.w) * sx + 4;
      let my = rect.top + r.y * sy;
      if (mx + 170 > window.innerWidth) mx = Math.max(0, rect.left + r.x * sx - 170);
      if (my + 110 > window.innerHeight) my = window.innerHeight - 110;
      menu.style.left = mx + "px";
      menu.style.top = my + "px";
      menu.style.display = "block";
    }
    function hideMenu() { menu.style.display = "none"; }

    // --- paste ---
    function startPaste() {
      if (!clipboard || pasteMode) return;
      hideMenu();
      clearSel();
      pasteMode = true;
      pasteW = clipboard.width;
      pasteH = clipboard.height;
      pasteX = Math.round((w - pasteW) / 2);
      pasteY = Math.round((h - pasteH) / 2);
      selCanvas.classList.remove("active");
      selCanvas.classList.add("pasting");
      pasteBar.classList.add("active");
      renderPaste();
      syncButtons();
    }
    function renderPaste() {
      selCtx.clearRect(0, 0, w, h);
      selCtx.drawImage(clipboard, pasteX, pasteY, pasteW, pasteH);
      selCtx.save();
      selCtx.setLineDash([6, 4]);
      selCtx.strokeStyle = "#00aaff";
      selCtx.lineWidth = 2;
      selCtx.strokeRect(pasteX, pasteY, pasteW, pasteH);
      selCtx.setLineDash([]);
      const hs = Math.max(8, Math.min(16, Math.min(pasteW, pasteH) * 0.1));
      selCtx.fillStyle = "#00aaff";
      for (const [cx, cy] of pasteCorners()) selCtx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      selCtx.font = "14px monospace";
      selCtx.fillText(`${Math.round(pasteW)}×${Math.round(pasteH)}`, pasteX, pasteY - 6);
      selCtx.restore();
    }
    function pasteCorners() {
      return [[pasteX, pasteY, "tl"], [pasteX + pasteW, pasteY, "tr"], [pasteX, pasteY + pasteH, "bl"], [pasteX + pasteW, pasteY + pasteH, "br"]];
    }
    function hitPasteCorner(p) {
      const r = selCanvas.getBoundingClientRect();
      const hit = 14 * (w / r.width);
      for (const [cx, cy, c] of pasteCorners()) {
        if (Math.abs(p.x - cx) < hit && Math.abs(p.y - cy) < hit) return c;
      }
      return null;
    }
    function inPasteRect(p) {
      return p.x >= pasteX && p.x <= pasteX + pasteW && p.y >= pasteY && p.y <= pasteY + pasteH;
    }
    function confirmPaste() {
      if (!clipboard || !pasteMode) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(clipboard, pasteX, pasteY, pasteW, pasteH);
      dirty = true;
      cancelPaste();
      pushHistory();
    }
    function cancelPaste() {
      pasteMode = false;
      pasteDrag = pasteResize = null;
      selCtx.clearRect(0, 0, w, h);
      selCanvas.classList.remove("pasting");
      selCanvas.style.cursor = "";
      if (currentTool === "select") selCanvas.classList.add("active");
      pasteBar.classList.remove("active");
      syncButtons();
    }

    // --- loupe ---
    function loupeUpdate(e) {
      if (currentTool === "select" || pasteMode) return loupeHide();
      const rect = drawCanvas.getBoundingClientRect();
      const cx = e.clientX, cy = e.clientY;
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return loupeHide();
      let lx = cx + 20, ly = cy - LOUPE_SIZE - 20;
      if (lx + LOUPE_SIZE > window.innerWidth) lx = cx - LOUPE_SIZE - 20;
      if (ly < 0) ly = cy + 20;
      loupe.style.left = lx + "px";
      loupe.style.top = ly + "px";
      loupe.style.display = "block";
      const srcX = (cx - rect.left) * (w / rect.width);
      const srcY = (cy - rect.top) * (h / rect.height);
      const srcR = LOUPE_CANVAS / (2 * LOUPE_ZOOM);
      const lc = loupeCanvas.getContext("2d");
      lc.imageSmoothingEnabled = false;
      lc.clearRect(0, 0, LOUPE_CANVAS, LOUPE_CANVAS);
      lc.drawImage(bgCanvas, srcX - srcR, srcY - srcR, srcR * 2, srcR * 2, 0, 0, LOUPE_CANVAS, LOUPE_CANVAS);
      lc.drawImage(drawCanvas, srcX - srcR, srcY - srcR, srcR * 2, srcR * 2, 0, 0, LOUPE_CANVAS, LOUPE_CANVAS);
      const half = LOUPE_CANVAS / 2;
      lc.strokeStyle = "rgba(255,255,255,0.5)";
      lc.lineWidth = 1;
      lc.beginPath();
      lc.moveTo(half, 0); lc.lineTo(half, LOUPE_CANVAS);
      lc.moveTo(0, half); lc.lineTo(LOUPE_CANVAS, half);
      lc.stroke();
    }
    function loupeHide() { loupe.style.display = "none"; }

    // --- drawing ---
    function strokeTo(p, pressure) {
      if (currentTool === "airbrush") {
        ctx.globalCompositeOperation = "source-over";
        const radius = lineWidth * (0.5 + pressure * 1.5);
        airbrushSpray(ctx, p.x, p.y, radius, currentColor, Math.round(radius * pressure * 3));
        return;
      }
      if (currentTool === "brush") ctx.lineWidth = lineWidth * pressure;
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }

    drawCanvas.addEventListener("pointerdown", e => {
      if (e.button !== 0 || pasteMode || currentTool === "select") return;
      e.preventDefault();
      try { drawCanvas.setPointerCapture(e.pointerId); } catch (_) {}
      drawing = true;
      dirty = true;
      const p = coords(e);
      const pressure = e.pressure || 0.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.lineWidth = lineWidth;
      ctx.globalCompositeOperation = currentTool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = currentTool === "eraser" ? "rgba(0,0,0,1)" : currentTool === "overwrite" ? "#ffffff" : currentColor;
      // A click without movement still leaves a dot.
      strokeTo({ x: p.x + 0.01, y: p.y }, pressure);
    });
    drawCanvas.addEventListener("pointermove", e => {
      loupeUpdate(e);
      if (!drawing) return;
      e.preventDefault();
      strokeTo(coords(e), e.pressure || 0.5);
    });
    function endDraw() {
      if (!drawing) return;
      drawing = false;
      pushHistory();
    }
    drawCanvas.addEventListener("pointerup", endDraw);
    drawCanvas.addEventListener("pointercancel", endDraw);
    drawCanvas.addEventListener("pointerleave", () => { if (!drawing) loupeHide(); });

    // --- selection & paste pointer events ---
    selCanvas.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const p = coords(e);
      if (pasteMode) {
        e.preventDefault();
        const corner = hitPasteCorner(p);
        if (corner) {
          pasteResize = { start: p, origW: pasteW, origH: pasteH, origX: pasteX, origY: pasteY, corner };
        } else if (inPasteRect(p)) {
          pasteDrag = { start: p, origX: pasteX, origY: pasteY };
        }
        if (pasteResize || pasteDrag) { try { selCanvas.setPointerCapture(e.pointerId); } catch (_) {} }
        return;
      }
      if (currentTool === "select") {
        e.preventDefault();
        try { selCanvas.setPointerCapture(e.pointerId); } catch (_) {}
        hideMenu();
        selecting = true;
        selStart = p;
        selEnd = { ...p };
        drawSelRect();
      }
    });
    selCanvas.addEventListener("pointermove", e => {
      const p = coords(e);
      if (pasteMode) {
        if (pasteResize) {
          e.preventDefault();
          const r = pasteResize;
          const dx = p.x - r.start.x, dy = p.y - r.start.y;
          const lock = keepRatio.checked;
          const ar = r.origW / r.origH;
          const right = r.corner.includes("r"), bottom = r.corner.includes("b");
          const nw = Math.max(MIN_PASTE, r.origW + (right ? dx : -dx));
          const nh = lock ? Math.max(MIN_PASTE, nw / ar) : Math.max(MIN_PASTE, r.origH + (bottom ? dy : -dy));
          pasteW = nw;
          pasteH = nh;
          pasteX = right ? r.origX : r.origX + r.origW - nw;
          pasteY = bottom ? r.origY : r.origY + r.origH - nh;
          renderPaste();
        } else if (pasteDrag) {
          e.preventDefault();
          pasteX = pasteDrag.origX + (p.x - pasteDrag.start.x);
          pasteY = pasteDrag.origY + (p.y - pasteDrag.start.y);
          renderPaste();
        } else {
          const corner = hitPasteCorner(p);
          selCanvas.style.cursor = corner
            ? (corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize")
            : inPasteRect(p) ? "move" : "default";
        }
        return;
      }
      if (selecting) {
        e.preventDefault();
        selEnd = p;
        drawSelRect();
      }
    });
    function endSel(e) {
      if (pasteMode) {
        pasteDrag = pasteResize = null;
        return;
      }
      if (!selecting) return;
      selecting = false;
      const r = selRect();
      if (r && r.w > 4 && r.h > 4) showMenu(e);
      else clearSel();
    }
    selCanvas.addEventListener("pointerup", endSel);
    selCanvas.addEventListener("pointercancel", endSel);

    // --- keyboard (kept away from ComfyUI) ---
    root.addEventListener("keydown", e => {
      e.stopPropagation();
      const key = e.key.toLowerCase();
      if (e.key === "Escape") {
        e.preventDefault();
        if (pasteMode) return cancelPaste();
        if (menu.style.display === "block") { hideMenu(); clearSel(); return; }
        close();
      } else if (e.key === "Enter" && pasteMode) {
        e.preventDefault();
        confirmPaste();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "z") {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && key === "v") {
        e.preventDefault();
        startPaste();
      }
    });
    for (const type of ["keyup", "keypress", "paste", "drop", "dragover", "wheel", "contextmenu"]) {
      root.addEventListener(type, e => {
        e.stopPropagation();
        if (type === "contextmenu" || type === "drop" || type === "dragover") e.preventDefault();
      });
    }

    // --- finish ---
    function teardown() {
      root.remove();
      history = [];
    }
    function close() {
      if (dirty && history.length > 1 && !confirm("Discard the drawing?")) return;
      teardown();
      resolve(null);
    }
    function finish(mode) {
      if (pasteMode) confirmPaste();
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const o = out.getContext("2d");
      if (mode === "composite") {
        o.drawImage(bgCanvas, 0, 0);
      } else if (mode === "lines") {
        o.fillStyle = "#ffffff";
        o.fillRect(0, 0, w, h);
      }
      o.drawImage(drawCanvas, 0, 0);
      const data = history[history.length - 1].data;
      let empty = true;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i]) { empty = false; break; }
      }
      saveBtn.disabled = linesBtn.disabled = true;
      out.toBlob(blob => {
        teardown();
        if (!blob) return resolve(null);
        resolve({ blob, mode, empty });
      }, "image/png");
    }

    document.body.appendChild(root);
    setTool(currentTool);
    setColor(currentColor);
    setSize(lineWidth);
    pushHistory();
    root.focus({ preventScroll: true });
  });
}
