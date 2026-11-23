#!/usr/bin/env python3
"""Build build/station-titled.png from public/art/station.png.

NOT FOR PUBLICATION. The station art is CC BY-NC-ND 4.0 (NoDerivatives), so
this extended version may not be shared without the generator authors'
permission. Output goes to build/, which is git-ignored and outside public/.

Extends the 320x180 station art to 320x200 (VGA mode 13h) with a strip of
starfield made from the art's own small stars, then letters the full name
into the bottom in Silkscreen at 8px, where one font pixel = one art pixel.

Needs: pip install pillow numpy fonttools brotli
Run from the repo root:  python3 tools/make-titled-art.py
"""
import io
import random

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

SRC = "public/art/station.png"
OUT = "build/station-titled.png"
FONT = "public/fonts/silkscreen-400.woff2"
LINES = ["TECHNOCRATIC INCORPORATED", "MULTI-NODE DIGITAL ASTRODROME"]
NEW_HEIGHT = 200
LINE_TOPS = [179, 188]          # top row of each line's capitals
BG = np.array([0x16, 0x1D, 0x2E])
TEXT = np.array([0xA3, 0xB8, 0xCE])
SHADOW = np.array([0x1B, 0x2C, 0x54])
CLEAR_MARGIN = 3                # starless margin around the text
SEED = 72                       # fixed so the output is reproducible


def load_font():
    f = TTFont(FONT)
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, 8)


def small_star_sprites(img):
    """Small, isolated 8-connected groups of non-background pixels."""
    h, w, _ = img.shape
    mask = (img != BG).any(2)
    seen = np.zeros_like(mask)
    sprites = []
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or seen[y, x]:
                continue
            stack, comp = [(y, x)], []
            seen[y, x] = True
            while stack:
                cy, cx = stack.pop()
                comp.append((cy, cx))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            ys = [p[0] for p in comp]
            xs = [p[1] for p in comp]
            if max(ys) - min(ys) < 5 and max(xs) - min(xs) < 5 and len(comp) <= 9:
                sprites.append([(py - min(ys), px - min(xs), tuple(img[py, px])) for py, px in comp])
    return sprites


def render_line(font, text):
    """1-bit render with 1px letter-spacing, cropped to the inked pixels."""
    im = Image.new("L", (400, 16), 0)
    d = ImageDraw.Draw(im)
    d.fontmode = "1"
    x = 0
    for ch in text:
        d.text((x, 0), ch, font=font, fill=255)
        x += int(font.getlength(ch)) + 1
    a = np.asarray(im) > 0
    ys, xs = np.nonzero(a)
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def main():
    import os
    os.makedirs("build", exist_ok=True)
    src = np.asarray(Image.open(SRC).convert("RGB"))
    h, w, _ = src.shape
    out = np.empty((NEW_HEIGHT, w, 3), np.uint8)
    out[:] = BG
    out[:h] = src

    font = load_font()
    lines = [render_line(font, t) for t in LINES]
    boxes = [(top, (w - l.shape[1]) // 2, *l.shape) for l, top in zip(lines, LINE_TOPS)]

    keep_out = np.zeros((NEW_HEIGHT, w), bool)
    for top, left, lh, lw in boxes:
        keep_out[top - CLEAR_MARGIN:top + lh + CLEAR_MARGIN + 1, left - CLEAR_MARGIN:left + lw + CLEAR_MARGIN + 1] = True
    out[(out != BG).any(2) & keep_out] = BG

    sprites = small_star_sprites(src)
    target = round(len(sprites) / (h * w) * (NEW_HEIGHT - h) * w)
    occupied = (out != BG).any(2) | keep_out
    rng = random.Random(SEED)
    placed = tries = 0
    while placed < target and tries < 5000:
        tries += 1
        sp = rng.choice(sprites)
        sh = max(p[0] for p in sp) + 1
        sw = max(p[1] for p in sp) + 1
        y = rng.randrange(h - 2, NEW_HEIGHT - sh)
        x = rng.randrange(0, w - sw)
        if occupied[max(0, y - 2):y + sh + 2, max(0, x - 2):x + sw + 2].any():
            continue
        for py, px, c in sp:
            out[y + py, x + px] = c
        occupied[y - 1:y + sh + 1, x - 1:x + sw + 1] = True
        placed += 1

    for l, (top, left, _, _) in zip(lines, boxes):
        ys, xs = np.nonzero(l)
        out[ys + top + 1, xs + left + 1] = SHADOW
        out[ys + top, xs + left] = TEXT

    Image.fromarray(out).save(OUT, optimize=True)
    print(f"wrote {OUT} ({w}x{NEW_HEIGHT}, {placed} stars added)")


if __name__ == "__main__":
    main()
