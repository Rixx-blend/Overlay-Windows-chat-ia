import base64
import io
import os
from datetime import datetime
from pathlib import Path

import mss
from PIL import Image, ImageDraw


MAX_SIZE = (1366, 768)


def capture_screen(add_grid=False):
    with mss.mss() as capture:
        monitor = capture.monitors[0]  # écran virtuel : inclut tous les moniteurs, pas seulement le principal
        shot = capture.grab(monitor)
        image = Image.frombytes("RGB", shot.size, shot.rgb)
        original_size = image.size
    image.thumbnail(MAX_SIZE, Image.Resampling.LANCZOS)
    if add_grid:
        draw = ImageDraw.Draw(image, "RGBA")
        width, height = image.size
        for value in range(100, 1000, 100):
            x = round(width * value / 1000)
            y = round(height * value / 1000)
            draw.line((x, 0, x, height), fill=(255, 255, 255, 48), width=1)
            draw.line((0, y, width, y), fill=(255, 255, 255, 48), width=1)
            draw.text((x + 3, 3), str(value), fill=(255, 255, 255, 150))
            draw.text((3, y + 3), str(value), fill=(255, 255, 255, 150))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=82, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {
        "image": image,
        "data_url": "data:image/jpeg;base64," + encoded,
        "width": image.width,
        "height": image.height,
        "screen_width": original_size[0],
        "screen_height": original_size[1],
        "screen_left": shot.left,
        "screen_top": shot.top,
    }


def save_debug_capture(image, output_dir, action=None):
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    marked = image.copy()
    if action and action.get("x") is not None and action.get("y") is not None:
        x = max(0, min(1000, int(action["x"])))
        y = max(0, min(1000, int(action["y"])))
        px = round(marked.width * x / 1000)
        py = round(marked.height * y / 1000)
        draw = ImageDraw.Draw(marked)
        radius = max(6, round(marked.width / 120))
        draw.ellipse((px-radius, py-radius, px+radius, py+radius), fill=(255, 25, 25), outline=(255, 255, 255), width=2)
    filename = datetime.now().strftime("%Y%m%d_%H%M%S_%f") + ".jpg"
    marked.save(directory / filename, quality=88)
