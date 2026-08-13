#!/usr/bin/env python3
"""Pad macOS icon artwork to the Dock safe area, then rebuild icon.icns.

Idempotent: if opaque content is already at the target scale (within a small
tolerance for anti-aliased edges), the PNG is left unchanged.

Rebuilds build/icon.icns from the padded iconset. On macOS this prefers
`iconutil` via argv-only subprocess (darwin-gated). Elsewhere it writes a
PNG-based .icns that encodes the iconset files directly.
"""
from __future__ import annotations

import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONSET = ROOT / "build" / "icon.iconset"
ICON_1024 = ROOT / "build" / "icon-1024.png"
ICNS = ROOT / "build" / "icon.icns"

TARGET_SCALE = 0.80
# Ignore near-transparent AA fringe when measuring content.
ALPHA_THRESHOLD = 16

# Iconset filename → ICNS type. Same PNG types iconutil emits for retina sets.
ICNS_PNG_MAP = (
    ("icon_16x16@2x.png", b"ic11"),
    ("icon_32x32@2x.png", b"ic12"),
    ("icon_128x128.png", b"ic07"),
    ("icon_128x128@2x.png", b"ic13"),
    ("icon_256x256.png", b"ic08"),
    ("icon_256x256@2x.png", b"ic14"),
    ("icon_512x512.png", b"ic09"),
    ("icon_512x512@2x.png", b"ic10"),
)


def opaque_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = img.getchannel("A")
    mask = alpha.point(lambda p: 255 if p > ALPHA_THRESHOLD else 0)
    return mask.getbbox()


def already_padded(img: Image.Image, scale: float = TARGET_SCALE) -> bool:
    """True when opaque content already fits in the Dock safe area.

    Only shrinks oversized artwork. A second run is a no-op, including on
    tiny sizes where int(size * scale) is a few percent below `scale`.
    """
    bbox = opaque_bbox(img)
    if bbox is None:
        return True
    width, height = img.size
    content_w = bbox[2] - bbox[0]
    content_h = bbox[3] - bbox[1]
    # +2px for anti-aliased edges that sit outside the scaled rect.
    return content_w <= int(width * scale) + 2 and content_h <= int(height * scale) + 2


def add_padding(path: Path, scale: float = TARGET_SCALE) -> str:
    img = Image.open(path)
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    if already_padded(img, scale):
        print(f"skip (already padded) {path}")
        return "skipped"

    width, height = img.size
    new_width = int(width * scale)
    new_height = int(height * scale)
    scaled = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    padded = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    padded.paste(scaled, ((width - new_width) // 2, (height - new_height) // 2), scaled)
    padded.save(path, "PNG")
    print(f"padded {path}")
    return "padded"


def write_icns(iconset: Path, dest: Path) -> None:
    """Encode iconset PNGs into a valid Apple Icon Image (.icns) file."""
    chunks: list[bytes] = []
    for name, ostype in ICNS_PNG_MAP:
        path = iconset / name
        if not path.is_file():
            continue
        data = path.read_bytes()
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise SystemExit(f"{path} is not a PNG; refusing to pack into icns")
        chunks.append(ostype + struct.pack(">I", 8 + len(data)) + data)
    if not chunks:
        raise SystemExit(f"no iconset PNGs found in {iconset}")
    body = b"".join(chunks)
    dest.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)
    print(f"wrote {dest} ({dest.stat().st_size} bytes, {len(chunks)} icons)")


def rebuild_icns(iconset: Path, dest: Path) -> None:
    if sys.platform == "darwin":
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(dest)],
            check=True,
        )
        print(f"wrote {dest} via iconutil")
        return
    write_icns(iconset, dest)


def main() -> None:
    if ICONSET.is_dir():
        for png in sorted(ICONSET.glob("*.png")):
            add_padding(png)
    if ICON_1024.is_file():
        add_padding(ICON_1024)
    rebuild_icns(ICONSET, ICNS)
    print("done")


if __name__ == "__main__":
    main()
