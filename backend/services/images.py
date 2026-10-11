"""Proof photo handling: decode, downscale, strip metadata, fingerprint, store."""
import base64
import binascii
import io
import os

from PIL import Image, ImageOps

MAX_SIDE = 1024
MAX_PIXELS = 25_000_000
ALLOWED = {"JPEG", "PNG", "WEBP"}
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def parse_data_url(value):
    """Bytes of a `data:image/...;base64,...` URL. Raises ValueError for anything else."""
    if not isinstance(value, str) or not value.startswith("data:image/") or ";base64," not in value[:64]:
        raise ValueError("expected an image data URL")
    try:
        return base64.b64decode(value.split(",", 1)[1], validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("invalid base64")


def process(raw):
    """Returns (jpeg_bytes, phash_hex). The image is re-encoded, so EXIF and other metadata are dropped."""
    try:
        img = Image.open(io.BytesIO(raw))
        if img.format not in ALLOWED:
            raise ValueError("unsupported image type")
        img.load()
    except ValueError:
        raise
    except Exception:
        raise ValueError("not a readable image")
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85)
    return out.getvalue(), dhash(img)


def dhash(img):
    """64-bit difference hash as 16 hex chars. Near-identical photos differ in only a few bits."""
    px = img.convert("L").resize((9, 8), Image.Resampling.LANCZOS).tobytes()
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (px[row * 9 + col] > px[row * 9 + col + 1])
    return f"{bits:016x}"


def hamming(a, b):
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def save(directory, task_id, jpeg):
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{task_id}.jpg")
    with open(path, "wb") as f:
        f.write(jpeg)
    return path
