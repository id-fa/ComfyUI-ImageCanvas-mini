"""Collage compositing (pure Pillow, no ComfyUI imports).

Mirrors what the frontend canvas in web/image_collage.js draws, so the node
output matches what the user arranged on the node.

State layout (JSON written by the frontend):
    {
      "width": 1024, "height": 1024, "cols": 2, "rows": 2,
      "bg": "#000000", "border": true,
      "items": [{"image": "imagecanvas_mini/a.png", "cell": 0, "x": 0, "y": 0, "w": 512, "h": 512}, ...]
    }
Item coordinates are output pixels. Items are drawn in list order (last on top),
each clipped to its grid cell. A 1x1 grid is the free layout: any number of
items on the whole canvas, no border lines.
"""

import json

from PIL import Image, ImageColor, ImageDraw, ImageOps

DEFAULT_SIZE = 1024
MIN_SIZE = 16
MAX_SIZE = 8192
MAX_GRID = 8


def _clamp_int(value, low, high, default):
    try:
        return max(low, min(high, int(round(float(value)))))
    except (TypeError, ValueError, OverflowError):
        return default


def parse_state(raw):
    """Parse the widget JSON into a normalized dict. Empty/invalid -> empty canvas."""
    try:
        state = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        state = {}
    if not isinstance(state, dict):
        state = {}

    cols = _clamp_int(state.get("cols"), 1, MAX_GRID, 2)
    rows = _clamp_int(state.get("rows"), 1, MAX_GRID, 2)
    items = state.get("items")
    if not isinstance(items, list):
        items = []
    items = [
        it for it in items
        if isinstance(it, dict) and it.get("image")
        and _clamp_int(it.get("cell"), 0, cols * rows - 1, -1) == it.get("cell")
    ]
    bg = state.get("bg")
    return {
        "width": _clamp_int(state.get("width"), MIN_SIZE, MAX_SIZE, DEFAULT_SIZE),
        "height": _clamp_int(state.get("height"), MIN_SIZE, MAX_SIZE, DEFAULT_SIZE),
        "cols": cols,
        "rows": rows,
        "bg": bg if isinstance(bg, str) else "#000000",
        "border": bool(state.get("border", True)),
        "items": items,
    }


def image_names(state):
    return [it["image"] for it in state["items"]]


def _draw_item(canvas, img, item, bounds):
    cx0, cy0, cx1, cy1 = bounds
    try:
        fx0 = float(item["x"])
        fy0 = float(item["y"])
        fw = float(item["w"])
        fh = float(item["h"])
    except (KeyError, TypeError, ValueError):
        return
    if fw <= 0 or fh <= 0:
        return

    # Destination = image rect clipped to the cell, snapped to whole pixels.
    dx0 = round(max(fx0, cx0))
    dy0 = round(max(fy0, cy0))
    dx1 = round(min(fx0 + fw, cx1))
    dy1 = round(min(fy0 + fh, cy1))
    if dx1 <= dx0 or dy1 <= dy0:
        return

    # Matching source region, so only the visible part gets resampled.
    sw, sh = img.size
    box = (
        min(sw, max(0.0, (dx0 - fx0) / fw * sw)),
        min(sh, max(0.0, (dy0 - fy0) / fh * sh)),
        min(sw, max(0.0, (dx1 - fx0) / fw * sw)),
        min(sh, max(0.0, (dy1 - fy0) / fh * sh)),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return
    patch = img.resize((dx1 - dx0, dy1 - dy0), Image.Resampling.LANCZOS, box=box)
    canvas.paste(patch, (dx0, dy0), patch)


def _is_dark(rgb):
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128


def _draw_borders(canvas, cols, rows, bg_rgb):
    width, height = canvas.size
    color = (255, 255, 255) if _is_dark(bg_rgb) else (0, 0, 0)
    bw = max(2, round(min(width, height) / 256))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, width - 1, bw - 1], fill=color)
    draw.rectangle([0, height - bw, width - 1, height - 1], fill=color)
    draw.rectangle([0, 0, bw - 1, height - 1], fill=color)
    draw.rectangle([width - bw, 0, width - 1, height - 1], fill=color)
    for c in range(1, cols):
        x0 = round(c * width / cols - bw / 2)
        draw.rectangle([x0, 0, x0 + bw - 1, height - 1], fill=color)
    for r in range(1, rows):
        y0 = round(r * height / rows - bw / 2)
        draw.rectangle([0, y0, width - 1, y0 + bw - 1], fill=color)


def render_collage(state, open_image):
    """Composite the collage. `open_image(name)` returns a PIL image for an item."""
    width, height = state["width"], state["height"]
    cols, rows = state["cols"], state["rows"]
    try:
        bg_rgb = ImageColor.getrgb(state["bg"])[:3]
    except ValueError:
        bg_rgb = (0, 0, 0)
    canvas = Image.new("RGB", (width, height), bg_rgb)

    loaded = {}
    for item in state["items"]:
        name = item["image"]
        if name not in loaded:
            loaded[name] = ImageOps.exif_transpose(open_image(name)).convert("RGBA")
        c, r = item["cell"] % cols, item["cell"] // cols
        bounds = (c * width / cols, r * height / rows, (c + 1) * width / cols, (r + 1) * height / rows)
        _draw_item(canvas, loaded[name], item, bounds)

    if state["border"] and cols * rows > 1:
        _draw_borders(canvas, cols, rows, bg_rgb)
    return canvas
