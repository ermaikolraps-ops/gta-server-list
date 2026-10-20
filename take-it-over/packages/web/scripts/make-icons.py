"""Generates the PWA icons: captured 100 m squares under a targeting reticle."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (11, 15, 12, 255)
GRID = (40, 52, 42, 255)
TEAL = (52, 211, 153, 255)
AMBER = (251, 191, 36, 255)
RED = (239, 68, 68, 255)


def build(size, pad_ratio=0.0, rounded=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = size * 0.2 if rounded else 0
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    inner = size * (1 - 2 * pad_ratio)
    off = size * pad_ratio
    n = 6
    cell = inner * 0.8 / n
    x0 = off + inner * 0.1
    owned = {(1, 1): TEAL, (2, 1): TEAL, (2, 2): TEAL, (3, 2): TEAL, (2, 3): TEAL,
             (4, 3): AMBER, (4, 4): AMBER, (3, 4): AMBER, (1, 4): RED}
    for i in range(n):
        for j in range(n):
            x, y = x0 + i * cell, x0 + j * cell
            color = owned.get((i, j))
            g = cell * 0.08
            if color:
                d.rectangle([x + g, y + g, x + cell - g, y + cell - g], fill=color)
            else:
                d.rectangle([x + g, y + g, x + cell - g, y + cell - g], outline=GRID, width=max(1, int(size / 128)))
    c = size / 2
    r = inner * 0.3
    w = max(2, int(size / 40))
    d.ellipse([c - r, c - r, c + r, c + r], outline=(236, 253, 245, 255), width=w)
    for a, b in [((c, c - r * 1.35), (c, c - r * 0.55)), ((c, c + r * 0.55), (c, c + r * 1.35)),
                 ((c - r * 1.35, c), (c - r * 0.55, c)), ((c + r * 0.55, c), (c + r * 1.35, c))]:
        d.line([a, b], fill=(236, 253, 245, 255), width=w)
    return img


OUT.mkdir(parents=True, exist_ok=True)
build(192).save(OUT / "icon-192.png")
build(512).save(OUT / "icon-512.png")
build(512, pad_ratio=0.1, rounded=False).save(OUT / "maskable-512.png")
build(180, rounded=False).save(OUT / "apple-touch-icon.png")
build(64).save(OUT / "favicon.png")
print("icons written to", OUT)
