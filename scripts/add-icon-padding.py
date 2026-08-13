#!/usr/bin/env python3
"""Pad macOS icon artwork to the Dock safe area, then rebuild icon.icns.

Idempotent: if opaque content already fits the target scale (plus 1px for
anti-aliased edges), the PNG is left unchanged. Padding scales the opaque
bbox into the target rect — not the whole canvas — so a second, tighter
pass does not double-shrink already-padded artwork.

Rebuilds build/icon.icns from the padded iconset. On macOS this prefers
`iconutil` via argv-only subprocess (darwin-gated). Elsewhere it writes a
PNG-based .icns that encodes every iconset size (including 1x 16/32/64)
plus a TOC chunk, matching what iconutil emits.
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

# 80% (10% margin/side) still read oversized vs macOS 26 neighbors
# (Notes, VS Code). 70% is a tighter Apple-grid inset.
TARGET_SCALE = 0.70
# Ignore near-transparent AA fringe when measuring content.
ALPHA_THRESHOLD = 16

# Iconset filename → ICNS type. Includes 1x PNG types (icp4/5/6) that
# iconutil writes and that the previous Linux packer omitted — Dock can
# otherwise upscale a sparse set. Order matches iconutil (small → large).
ICNS_PNG_MAP = (
    ("icon_16x16.png", b"icp4"),
    ("icon_16x16@2x.png", b"ic11"),
    ("icon_32x32.png", b"icp5"),
    ("icon_32x32@2x.png", b"ic12"),
    ("icon_64x64.png", b"icp6"),
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

    Only shrinks oversized artwork. A second run is a no-op. Uses a 2%
    relative slop so 16×16 80% tiles still retarget to 70% (a +2px slop
    treated them as done).
    """
    bbox = opaque_bbox(img)
    if bbox is None:
        return True
    width, height = img.size
    content_w = bbox[2] - bbox[0]
    content_h = bbox[3] - bbox[1]
    return content_w / width <= scale + 0.02 and content_h / height <= scale + 0.02


def add_padding(path: Path, scale: float = TARGET_SCALE) -> str:
    img = Image.open(path)
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    if already_padded(img, scale):
        print(f"skip (already padded) {path}")
        return "skipped"

    width, height = img.size
    bbox = opaque_bbox(img)
    if bbox is None:
        print(f"skip (empty) {path}")
        return "skipped"
    content = img.crop(bbox)
    content_w, content_h = content.size
    target_w = max(1, round(width * scale))
    target_h = max(1, round(height * scale))
    ratio = min(target_w / content_w, target_h / content_h)
    fit_w = max(1, round(content_w * ratio))
    fit_h = max(1, round(content_h * ratio))
    scaled = content.resize((fit_w, fit_h), Image.Resampling.LANCZOS)
    padded = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    padded.paste(scaled, ((width - fit_w) // 2, (height - fit_h) // 2), scaled)
    padded.save(path, "PNG")
    print(f"padded {path}")
    return "padded"


def write_icns(iconset: Path, dest: Path) -> None:
    """Encode iconset PNGs into a valid Apple Icon Image (.icns) file."""
    icon_chunks: list[bytes] = []
    for name, ostype in ICNS_PNG_MAP:
        path = iconset / name
        if not path.is_file():
            continue
        data = path.read_bytes()
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise SystemExit(f"{path} is not a PNG; refusing to pack into icns")
        icon_chunks.append(ostype + struct.pack(">I", 8 + len(data)) + data)
    if not icon_chunks:
        raise SystemExit(f"no iconset PNGs found in {iconset}")
    # TOC lists each following icon chunk's type+length (iconutil does this;
    # a TOC-less PNG icns is easier for Finder/Dock to treat as incomplete).
    toc_body = b"".join(chunk[:8] for chunk in icon_chunks)
    toc = b"TOC " + struct.pack(">I", 8 + len(toc_body)) + toc_body
    body = toc + b"".join(icon_chunks)
    dest.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)
    print(f"wrote {dest} ({dest.stat().st_size} bytes, {len(icon_chunks)} icons + TOC)")


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
