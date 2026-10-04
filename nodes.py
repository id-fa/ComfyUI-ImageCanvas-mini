import hashlib
import os

import numpy as np
import torch
from PIL import Image

import folder_paths
from comfy_api.latest import ComfyExtension, io

from .collage import image_names, parse_state, render_collage


def _resolve_input_path(name):
    """Map a state image name ("subfolder/file.png") to a path inside input/."""
    input_dir = os.path.abspath(folder_paths.get_input_directory())
    path = os.path.abspath(os.path.join(input_dir, str(name)))
    try:
        inside = os.path.commonpath((input_dir, path)) == input_dir
    except ValueError:
        inside = False
    if not inside:
        raise ValueError(f"Image Collage: invalid image path: {name}")
    return path


def _open_image(name):
    path = _resolve_input_path(name)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Image Collage: image not found in input folder: {name}")
    return Image.open(path)


class ImageCollage(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ImageCanvasMini_ImageCollage",
            display_name="Image Collage (Canvas mini)",
            category="ImageCanvas-mini",
            description="Drop images onto the canvas on the node, arrange them in a grid or freely, and output the composited image.",
            search_aliases=["collage", "grid", "concat", "stitch", "combine images", "pad", "padding"],
            inputs=[
                # Written by web/image_collage.js; the text widget itself is hidden.
                io.String.Input("canvas_state", default="", socketless=True),
            ],
            outputs=[io.Image.Output(display_name="image")],
        )

    @classmethod
    def validate_inputs(cls, canvas_state) -> bool | str:
        for name in image_names(parse_state(canvas_state)):
            try:
                path = _resolve_input_path(name)
            except ValueError as e:
                return str(e)
            if not os.path.isfile(path):
                return f"Image not found in input folder: {name}"
        return True

    @classmethod
    def fingerprint_inputs(cls, canvas_state):
        m = hashlib.sha256()
        m.update(str(canvas_state).encode("utf-8"))
        for name in image_names(parse_state(canvas_state)):
            try:
                m.update(str(os.path.getmtime(_resolve_input_path(name))).encode())
            except (OSError, ValueError):
                m.update(b"missing")
        return m.hexdigest()

    @classmethod
    def execute(cls, canvas_state) -> io.NodeOutput:
        canvas = render_collage(parse_state(canvas_state), _open_image)
        image = torch.from_numpy(np.asarray(canvas, dtype=np.float32) / 255.0).unsqueeze(0)
        return io.NodeOutput(image)


class ImageCanvasMiniExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [ImageCollage]


async def comfy_entrypoint() -> ImageCanvasMiniExtension:
    return ImageCanvasMiniExtension()
