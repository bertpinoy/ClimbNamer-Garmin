"""Draws all ClimbNamer graphics:
  extension/icons/icon-{16,32,48,128}.png   orange icon (128 px has the 16 px padding Chrome asks for)
  store/promo-tile-440x280.png              Chrome Web Store small promo tile
  store/marquee-1400x560.png                Chrome Web Store marquee promo tile

Style: orange icon; dark slate "night ride" tiles with orange accents, topographic
contour lines and an elevation profile with the climbs highlighted.

Requires Pillow (python -m pip install pillow) and the Windows fonts Bahnschrift and
Segoe UI Variable. Run from the repository root:  python tools/make-graphics.py
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "extension" / "icons"
STORE = ROOT / "store"
FONTS = Path("C:/Windows/Fonts")
SS = 3  # supersampling for the tiles

# ------------------------------------------------------------------ palette
ORANGE = (255, 107, 26)
ORANGE_LIGHT = (255, 149, 64)
ORANGE_DEEP = (232, 74, 12)
NAVY = (12, 18, 32)
SLATE_TOP = (27, 38, 60)
CARD_BG = (30, 41, 64)
CARD_LINE = (51, 65, 92)
MIST = (148, 163, 184)
BODY = (203, 213, 225)
WHITE = (255, 255, 255)
PEAK_BACK = (255, 196, 150)
PEAK_FLANK = (255, 232, 214)


def bahn(size, var="Bold"):
    f = ImageFont.truetype(str(FONTS / "bahnschrift.ttf"), int(size))
    f.set_variation_by_name(var)
    return f


def seg(size, var="Regular"):
    f = ImageFont.truetype(str(FONTS / "SegUIVar.ttf"), int(size))
    try:
        f.set_variation_by_name(var)
    except Exception:
        pass
    return f


def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bot)))
    return img


def diag_grad(w, h, a, b):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = x / w * 0.45 + y / h * 0.55
            px[x, y] = tuple(round(c1 + (c2 - c1) * t) for c1, c2 in zip(a, b))
    return img


# ------------------------------------------------------------------ icon
def icon(size):
    """Orange rounded square, white mountain, navy pennant (orange-tipped peak at 16 px)."""
    S = 1024
    simple = size <= 16
    bg = diag_grad(256, 256, ORANGE_LIGHT, ORANGE_DEEP).resize((S, S), Image.BICUBIC).convert("RGBA")
    d = ImageDraw.Draw(bg)
    base = int(S * 0.86)
    d.polygon([(int(S * 0.02), base), (int(S * 0.30), int(S * 0.50)), (int(S * 0.60), base)], fill=PEAK_BACK)
    peak = (int(S * 0.56), int(S * (0.26 if not simple else 0.20)))
    d.polygon([(int(S * 0.14), base), peak, (int(S * 1.02), base)], fill=WHITE)
    d.polygon([peak, (int(S * 1.02), base), (int(S * 0.72), base)], fill=PEAK_FLANK)
    px, py = peak
    if not simple:
        # snow line
        d.polygon([(px - int(S * 0.115), py + int(S * 0.20)), (px - int(S * 0.04), py + int(S * 0.15)),
                   (px + int(S * 0.02), py + int(S * 0.22)), (px + int(S * 0.08), py + int(S * 0.17)),
                   (px + int(S * 0.13), py + int(S * 0.215)), (px, py)], fill=WHITE)
        # pennant on the summit
        top = int(S * 0.07)
        w = int(S * 0.03)
        d.rounded_rectangle([px - w // 2, top, px + w // 2, py + 6], radius=w // 2, fill=NAVY)
        d.polygon([(px + w // 2, top), (px + int(S * 0.29), top + int(S * 0.085)), (px + w // 2, top + int(S * 0.17))],
                  fill=NAVY)
    else:
        d.polygon([peak, (px - int(S * 0.16), py + int(S * 0.24)), (px + int(S * 0.17), py + int(S * 0.24))], fill=NAVY)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)
    bg.putalpha(mask)
    return bg.resize((size, size), Image.LANCZOS)


def icon128():
    big = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    art = icon(96)
    big.paste(art, (16, 16), art)
    return big


# ------------------------------------------------------------------ decorations
def topo(w, h, cx, cy, alpha, rings, step, seed, width):
    """Topographic contour lines around (cx, cy)."""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(1, rings + 1):
        r = i * step
        pts = []
        for k in range(181):
            a = k / 180 * 2 * math.pi
            wob = 1 + 0.10 * math.sin(3 * a + seed + i * 0.35) + 0.06 * math.sin(5 * a - seed * 1.7 + i * 0.2)
            pts.append((cx + r * 1.35 * wob * math.cos(a), cy + r * wob * math.sin(a)))
        d.line(pts + [pts[0]], fill=ORANGE + (alpha,), width=width, joint="curve")
    return layer


def profile_pts(x0, x1, y_base, amp, bumps):
    pts = []
    n = 400
    for k in range(n + 1):
        u = k / n
        y = 0.12 * math.sin(u * 9) + 0.05 * math.sin(u * 23)
        for c, s, hgt in bumps:
            y += hgt * math.exp(-((u - c) ** 2) / (2 * s * s))
        pts.append((x0 + (x1 - x0) * u, y_base - amp * y))
    return pts


def draw_profile(img, pts, climbs, line_w, labels=(), label_font=None):
    """Elevation profile: soft orange area, grey line, climbs highlighted in glowing orange."""
    w, h = img.size
    area = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(area).polygon(pts + [(pts[-1][0], h), (pts[0][0], h)], fill=(255, 140, 60, 255))
    ymin = min(p[1] for p in pts)
    grad = Image.new("L", (1, h), 0)
    for y in range(h):
        t = (y - ymin) / max(1, (h - ymin))
        grad.putpixel((0, y), int(max(0, min(1, 1 - t * 0.85)) * 120) if y >= ymin else 120)
    area.putalpha(Image.composite(grad.resize((w, h)), Image.new("L", (w, h), 0), area.split()[3]))
    img.alpha_composite(area)
    d = ImageDraw.Draw(img)
    d.line(pts, fill=MIST, width=line_w, joint="curve")
    n = len(pts) - 1
    for u0, u1 in climbs:
        seg_pts = pts[int(u0 * n): int(u1 * n) + 1]
        glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(glow).line(seg_pts, fill=ORANGE + (170,), width=line_w * 4, joint="curve")
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(line_w * 2)))
        d = ImageDraw.Draw(img)
        d.line(seg_pts, fill=ORANGE, width=int(line_w * 1.7), joint="curve")
        top = min(seg_pts, key=lambda p: p[1])
        r = line_w * 2.2
        d.ellipse([top[0] - r, top[1] - r, top[0] + r, top[1] + r], fill=WHITE, outline=ORANGE, width=max(2, line_w))
    for u, text in labels:
        seg_pts = pts[int(u * n) - 3: int(u * n) + 4]
        x, y = min(seg_pts, key=lambda p: p[1])
        tw = d.textlength(text, font=label_font)
        ph = label_font.size * 1.5
        bx0, by1 = x - tw / 2 - ph * 0.45, y - line_w * 5
        d.rounded_rectangle([bx0, by1 - ph, x + tw / 2 + ph * 0.45, by1], radius=ph / 2, fill=ORANGE)
        d.polygon([(x - ph * 0.22, by1 - 1), (x + ph * 0.22, by1 - 1), (x, by1 + ph * 0.25)], fill=ORANGE)
        d.text((x, by1 - ph / 2), text, font=label_font, fill=WHITE, anchor="mm")


def wordmark(d, x, y, size, sub_size, sub_dy):
    f = bahn(size, "Bold")
    d.text((x, y), "Climb", font=f, fill=WHITE)
    d.text((x + d.textlength("Climb", font=f), y), "Namer", font=f, fill=ORANGE)
    d.text((x + size * 0.05, y + sub_dy), "FOR GARMIN CONNECT AND STRAVA", font=bahn(sub_size, "SemiBold"), fill=MIST)


def card(img, x, y, w, rows):
    """Mock of the 'Climb names' panel, dark style."""
    s = SS
    head_h, row_h = 50 * s, 84 * s
    h = head_h + row_h * len(rows) + 4 * s
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x, y + 14 * s, x + w, y + h + 14 * s], radius=18 * s, fill=(0, 0, 0, 110))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18 * s)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x, y, x + w, y + h], radius=18 * s, fill=CARD_BG, outline=CARD_LINE, width=s)
    d.text((x + 22 * s, y + head_h / 2 + 2 * s), "Climb names", font=bahn(20 * s, "SemiBold"), fill=WHITE, anchor="lm")
    d.rounded_rectangle([x + w - 64 * s, y + 15 * s, x + w - 22 * s, y + 39 * s], radius=12 * s, fill=ORANGE)
    d.text((x + w - 43 * s, y + 27 * s), str(len(rows)), font=bahn(15 * s, "Bold"), fill=WHITE, anchor="mm")
    for i, (name, detail, stats) in enumerate(rows):
        ry = y + head_h + i * row_h
        d.line([x + 18 * s, ry, x + w - 18 * s, ry], fill=CARD_LINE, width=s)
        d.rounded_rectangle([x + 20 * s, ry + 18 * s, x + 50 * s, ry + 48 * s], radius=9 * s,
                            fill=ORANGE if i == 0 else CARD_LINE)
        d.text((x + 35 * s, ry + 33 * s), str(i + 1), font=bahn(16 * s, "Bold"), fill=WHITE, anchor="mm")
        d.text((x + 64 * s, ry + 12 * s), name, font=bahn(22 * s, "SemiBold"), fill=WHITE)
        d.text((x + 64 * s, ry + 42 * s), detail, font=seg(14 * s), fill=MIST)
        d.text((x + 64 * s, ry + 60 * s), stats, font=seg(14 * s, "Semibold"), fill=ORANGE)


# ------------------------------------------------------------------ tiles
def small_tile():
    W, H = 440 * SS, 280 * SS
    img = vgrad(W, H, SLATE_TOP, NAVY).convert("RGBA")
    img.alpha_composite(topo(W, H, W * 0.86, H * 0.18, 40, 12, 22 * SS, 1.2, SS))
    d = ImageDraw.Draw(img)
    ic = icon(74 * SS)
    img.alpha_composite(ic, (28 * SS, 28 * SS))
    d = ImageDraw.Draw(img)
    wordmark(d, 116 * SS, 30 * SS, 44 * SS, 13 * SS, 52 * SS)
    d.text((30 * SS, 124 * SS), "Know which climbs you ride.", font=bahn(22 * SS, "SemiBold"), fill=WHITE)
    pts = profile_pts(-10, W + 10, 262 * SS, 92 * SS, [(0.30, 0.06, 0.55), (0.70, 0.07, 0.85)])
    draw_profile(img, pts, [(0.20, 0.31), (0.58, 0.71)], 3 * SS,
                 labels=[(0.31, "Kemmelberg"), (0.71, "Koppenberg")], label_font=bahn(12 * SS, "SemiBold"))
    return img.resize((440, 280), Image.LANCZOS).convert("RGB")


def marquee():
    W, H = 1400 * SS, 560 * SS
    img = vgrad(W, H, SLATE_TOP, NAVY).convert("RGBA")
    img.alpha_composite(topo(W, H, W * 0.70, H * 0.30, 34, 16, 30 * SS, 0.4, SS))
    # Profile: highlighted climbs left of the card; the part under the card stays low.
    pts = profile_pts(-20, W + 20, 540 * SS, 120 * SS,
                      [(0.12, 0.04, 0.5), (0.36, 0.05, 0.75), (0.56, 0.035, 0.65), (0.88, 0.06, 0.35)])
    draw_profile(img, pts, [(0.05, 0.13), (0.28, 0.37), (0.49, 0.57)], 3 * SS)
    ic = icon(112 * SS)
    img.alpha_composite(ic, (88 * SS, 78 * SS))
    d = ImageDraw.Draw(img)
    wordmark(d, 222 * SS, 70 * SS, 84 * SS, 22 * SS, 98 * SS)
    d.text((90 * SS, 246 * SS), "Know which climbs you ride.", font=bahn(44 * SS, "SemiBold"), fill=WHITE)
    d.text((92 * SS, 310 * SS), "Finds and names the climbs on your Garmin and Strava routes —", font=seg(24 * SS), fill=BODY)
    d.text((92 * SS, 344 * SS), "straight from OpenStreetMap.", font=seg(24 * SS), fill=BODY)
    card(img, 930 * SS, 48 * SS, 390 * SS, [
        ("Kemmelberg", "via Lettingstraat / Kemmelbergweg", "2.8 km · 3.8% · +124 m"),
        ("Koppenberg", "Melden", "0.6 km · 11.6% · +64 m"),
        ("Paterberg", "Kluisbergen", "0.4 km · 12.5% · +48 m"),
        ("Oude Kwaremont", "Kluisbergen", "2.2 km · 4.2% · +93 m"),
    ])
    return img.resize((1400, 560), Image.LANCZOS).convert("RGB")


def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48):
        icon(size).save(ICONS / f"icon-{size}.png")
    icon128().save(ICONS / "icon-128.png")
    STORE.mkdir(exist_ok=True)
    small_tile().save(STORE / "promo-tile-440x280.png", optimize=True)
    marquee().save(STORE / "marquee-1400x560.png", optimize=True)
    for p in sorted(ICONS.glob("icon-*.png")) + [STORE / "promo-tile-440x280.png", STORE / "marquee-1400x560.png"]:
        print("wrote", p.relative_to(ROOT))


if __name__ == "__main__":
    main()
