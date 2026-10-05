"""Collage compositing (pure Pillow, no ComfyUI imports).

Mirrors what the frontend canvas in web/image_collage.js draws, so the node
output matches what the user arranged on the node.

State layout (JSON written by the frontend):
    {
      "width": 1024, "height": 1024, "cols": 2, "rows": 2,
      "bg": "#000000", "border": true,
      "items": [{"image": "imagecanvas_mini/a.png", "cell": 0, "x": 0, "y": 0, "w": 512, "h": 512, "rot": 0}, ...],
      "mask": [{"s": 64, "e": 0, "p": [x0, y0, x1, y1, ...]}, ...]
    }
Item coordinates are output pixels. Items are drawn in list order (last on top),
each clipped to its grid cell. x/y/w/h is the unrotated box; "rot" (degrees,
clockwise) turns it around its center. A 1x1 grid is the free layout: any
number of items on the whole canvas, no border lines.
"mask" is the inpaint mask as brush strokes replayed in order: "s" is the brush
diameter, "e" marks an eraser stroke, "p" the flattened points.
"""

import json
import math

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
    mask = state.get("mask")
    if not isinstance(mask, list):
        mask = []
    return {
        "width": _clamp_int(state.get("width"), MIN_SIZE, MAX_SIZE, DEFAULT_SIZE),
        "height": _clamp_int(state.get("height"), MIN_SIZE, MAX_SIZE, DEFAULT_SIZE),
        "cols": cols,
        "rows": rows,
        "bg": bg if isinstance(bg, str) else "#000000",
        "border": bool(state.get("border", True)),
        "items": items,
        "mask": [st for st in (_parse_stroke(st) for st in mask) if st],
    }


def _parse_stroke(stroke):
    try:
        size = float(stroke["s"])
        points = [float(v) for v in stroke["p"]]
        erase = bool(stroke.get("e"))
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
    if not (0 < size <= MAX_SIZE) or len(points) < 2 or not all(map(math.isfinite, points)):
        return None
    return {"s": size, "e": erase, "p": list(zip(points[0::2], points[1::2]))}


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
    try:
        rot = float(item.get("rot") or 0) % 360
    except (TypeError, ValueError):
        rot = 0.0
    if rot:
        _draw_item_rotated(canvas, img, (fx0, fy0, fw, fh), bounds, rot)
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


def _draw_item_rotated(canvas, img, rect, bounds, rot):
    fx0, fy0, fw, fh = rect
    cx, cy = fx0 + fw / 2, fy0 + fh / 2
    cos, sin = math.cos(math.radians(rot)), math.sin(math.radians(rot))

    # Destination = bounding box of the turned rect, clipped to the cell.
    xs, ys = [], []
    for lx, ly in ((-fw / 2, -fh / 2), (fw / 2, -fh / 2), (fw / 2, fh / 2), (-fw / 2, fh / 2)):
        xs.append(cx + lx * cos - ly * sin)
        ys.append(cy + lx * sin + ly * cos)
    dx0 = max(math.floor(min(xs)), round(bounds[0]))
    dy0 = max(math.floor(min(ys)), round(bounds[1]))
    dx1 = min(math.ceil(max(xs)), round(bounds[2]))
    dy1 = min(math.ceil(max(ys)), round(bounds[3]))
    if dx1 <= dx0 or dy1 <= dy0:
        return

    # The affine transform samples without area averaging, so shrink first.
    if fw < img.width or fh < img.height:
        img = img.resize((max(1, round(fw)), max(1, round(fh))), Image.Resampling.LANCZOS)
    kx, ky = img.width / fw, img.height / fh

    # Destination pixel -> source pixel: undo the rotation around the center.
    ox, oy = dx0 - cx, dy0 - cy
    matrix = (
        cos * kx, sin * kx, (ox * cos + oy * sin + fw / 2) * kx,
        -sin * ky, cos * ky, (-ox * sin + oy * cos + fh / 2) * ky,
    )
    # Premultiplied alpha keeps the antialiased edges free of dark fringes.
    patch = img.convert("RGBa").transform(
        (dx1 - dx0, dy1 - dy0), Image.Transform.AFFINE, matrix, resample=Image.Resampling.BICUBIC
    ).convert("RGBA")
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


def render_mask(state):
    """Rasterize the mask strokes to an "L" image (255 = masked), output sized."""
    width, height = state["width"], state["height"]
    strokes = state["mask"]
    if not strokes:
        return Image.new("L", (width, height), 0)
    # Draw at twice the size and shrink for smooth edges (skipped for huge outputs).
    ss = 2 if width * height <= 4096 * 4096 else 1
    mask = Image.new("L", (width * ss, height * ss), 0)
    draw = ImageDraw.Draw(mask)
    for stroke in strokes:
        fill = 0 if stroke["e"] else 255
        radius = stroke["s"] * ss / 2
        points = [(x * ss, y * ss) for x, y in stroke["p"]]
        if len(points) > 1:
            draw.line(points, fill=fill, width=max(1, round(stroke["s"] * ss)))
        # Round caps and joins, as the editor draws them.
        for x, y in points:
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=fill)
    if ss > 1:
        mask = mask.resize((width, height), Image.Resampling.BOX)
    return mask
