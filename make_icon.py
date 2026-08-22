"""Genera icon.ico: un radar verde estilo mapa de GTA sobre fondo oscuro."""
import math
from PIL import Image, ImageDraw

BG = (18, 21, 26, 255)
GREEN = (110, 231, 110, 255)
GREEN_DIM = (60, 130, 70, 255)
AMBER = (255, 179, 64, 255)


def build(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * 0.06
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=size * 0.22, fill=BG)

    cx = cy = size / 2
    r = size * 0.34
    for i in range(3, 0, -1):
        d.ellipse([cx - r * i / 3, cy - r * i / 3, cx + r * i / 3, cy + r * i / 3],
                   outline=GREEN_DIM, width=max(1, int(size * 0.012)))
    d.line([cx - r, cy, cx + r, cy], fill=GREEN_DIM, width=max(1, int(size * 0.01)))
    d.line([cx, cy - r, cx, cy + r], fill=GREEN_DIM, width=max(1, int(size * 0.01)))

    ang = math.radians(-55)
    d.line([cx, cy, cx + r * math.cos(ang), cy + r * math.sin(ang)], fill=GREEN, width=max(2, int(size * 0.03)))

    dots = [(0.5, -0.4), (-0.55, -0.1), (0.2, 0.5), (-0.25, 0.35)]
    for dx, dy in dots:
        px, py = cx + dx * r, cy + dy * r
        rad = size * 0.035
        d.ellipse([px - rad, py - rad, px + rad, py + rad], fill=AMBER)

    return img


sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [build(s) for s in sizes]
imgs[-1].save("icon.ico", sizes=[(s, s) for s in sizes])
imgs[-1].save("icon.png")
print("icon.ico e icon.png generados")
