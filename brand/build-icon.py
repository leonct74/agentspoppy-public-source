#!/usr/bin/env python3
# Copyright 2026 Marco Tomasello (AgentsPoppy)
# SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
"""Build the macOS app-icon PNG (brand/AppIcon.png) with a REAL alpha channel.

Why this exists: qlmanage does not preserve SVG transparency — it bakes a solid
white background, which made the dock icon a white *square*. We build the PNG
directly in PIL instead: the standard macOS 824/1024 squircle grid (transparent
corners + margin) so it renders rounded like every other app icon.

Usage:
    python3 brand/build-icon.py            # light tile (default)
    python3 brand/build-icon.py dark       # dark navy tile (mark inner -> white)

Then regenerate the icon set:
    npm run -w @agentspoppy/app tauri -- icon ../brand/AppIcon.png
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SZ = 1024
HERE = __file__.rsplit("/", 1)[0]
DARK = len(sys.argv) > 1 and sys.argv[1] == "dark"


def vgrad(top, bot):
    g = np.zeros((SZ, SZ, 4), np.uint8)
    for y in range(SZ):
        t = y / (SZ - 1)
        g[y, :, 0] = round(top[0] + (bot[0] - top[0]) * t)
        g[y, :, 1] = round(top[1] + (bot[1] - top[1]) * t)
        g[y, :, 2] = round(top[2] + (bot[2] - top[2]) * t)
        g[y, :, 3] = 255
    return Image.fromarray(g, "RGBA")


# --- extract the mark from the white-backed original with a recovered alpha ---
src = np.asarray(Image.open(f"{HERE}/AgentsPoppy.png").convert("RGB")).astype(np.float32)
R, G, B = src[..., 0], src[..., 1], src[..., 2]
alpha = np.clip((255.0 - np.minimum(np.minimum(R, G), B)) * 1.5, 0, 255)
red = (R > 1.35 * B) & (R > 110) & (alpha > 40)

rgb = src.copy()
if DARK:                                   # navy elements -> white so they read on dark
    rgb[(~red) & (alpha > 40)] = [255, 255, 255]
mark = Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8))
ys, xs = np.where(alpha > 30)
mark = mark.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))

# --- compose icon: squircle tile + mark ---
icon = Image.new("RGBA", (SZ, SZ), (0, 0, 0, 0))
mask = Image.new("L", (SZ, SZ), 0)
ImageDraw.Draw(mask).rounded_rectangle([100, 100, 924, 924], radius=185, fill=255)
tile = vgrad((26, 60, 102), (11, 29, 54)) if DARK else vgrad((255, 255, 255), (233, 238, 244))
icon.paste(tile, (0, 0), mask)

mw, mh = mark.size
s = int(824 * 0.60) / mh
mark = mark.resize((int(mw * s), int(mh * s)), Image.LANCZOS)
nw, nh = mark.size
ox, oy = SZ // 2 - nw // 2, SZ // 2 + 6 - nh // 2

shm = Image.new("L", (SZ, SZ), 0)
shm.paste(mark.split()[3], (ox, oy + 8))
shm = shm.filter(ImageFilter.GaussianBlur(10))
flood = (0, 0, 0, 90) if DARK else (13, 20, 36, 70)
icon = Image.alpha_composite(
    icon, Image.composite(Image.new("RGBA", (SZ, SZ), flood), Image.new("RGBA", (SZ, SZ), (0, 0, 0, 0)), shm)
)
icon.paste(mark, (ox, oy), mark)

icon.save(f"{HERE}/AppIcon.png")
print(f"wrote {HERE}/AppIcon.png  ({'dark' if DARK else 'light'} tile, transparent corners)")
