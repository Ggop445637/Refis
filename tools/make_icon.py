"""Рисует иконку Refis (assets/refis.ico и refis.png) — тот же рисунок, что img/logo.svg."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024  # рисуем крупно и уменьшаем — так края получаются гладкими
ROOT = Path(__file__).resolve().parent.parent


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(size):
    stops = [(0, (255, 195, 113)), (0.55, (255, 107, 107)), (1, (124, 92, 255))]
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t <= t1:
                    px[x, y] = lerp(c0, c1, (t - t0) / (t1 - t0))
                    break
    return g


def rounded_mask(size, box, r):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, r, fill=255)
    return m


def draw() -> Image.Image:
    k = S / 64
    grad = gradient(256).resize((S, S), Image.BICUBIC)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), rounded_mask(S, (0, 0, S - 1, S - 1), 15 * k))

    # блик сверху
    gloss = Image.new("L", (S, S), 0)
    gd = ImageDraw.Draw(gloss)
    for y in range(int(32 * k)):
        gd.line([(0, y), (S, y)], fill=int(90 * (1 - y / (32 * k))))
    gloss = Image.composite(gloss, Image.new("L", (S, S), 0), rounded_mask(S, (0, 0, S - 1, S - 1), 15 * k))
    white = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    white.putalpha(gloss)
    img = Image.alpha_composite(img, white)

    # задняя карточка (полупрозрачная, повёрнута)
    back = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(back).rounded_rectangle((13 * k, 14 * k, 40 * k, 47 * k), 5 * k, fill=(255, 255, 255, 107))
    back = back.rotate(13, center=(26.5 * k, 30.5 * k), resample=Image.BICUBIC)
    img = Image.alpha_composite(img, back)

    # тень и передняя карточка
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((22 * k, 17.5 * k, 50 * k, 51.5 * k), 5 * k, fill=(60, 10, 40, 90))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(1.6 * k)))
    front = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(front).rounded_rectangle((22 * k, 16 * k, 50 * k, 50 * k), 5 * k, fill=(255, 255, 255, 255))
    img = Image.alpha_composite(img, front)

    # солнце и горы на карточке — цветом градиента
    art = Image.new("L", (S, S), 0)
    ad = ImageDraw.Draw(art)
    ad.ellipse((38.4 * k, 21.4 * k, 45.6 * k, 28.6 * k), fill=255)
    ad.polygon([(25 * k, 46.5 * k), (32 * k, 36 * k), (37 * k, 42.5 * k), (40.5 * k, 38.5 * k), (47 * k, 46.5 * k)], fill=255)
    colored = grad.convert("RGBA")
    colored.putalpha(art)
    return Image.alpha_composite(img, colored)


if __name__ == "__main__":
    big = draw()
    out = ROOT / "assets"
    out.mkdir(exist_ok=True)
    big.resize((512, 512), Image.LANCZOS).save(out / "refis.png")
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    big.resize((256, 256), Image.LANCZOS).save(out / "refis.ico", sizes=[(s, s) for s in sizes])
    print("icon written:", out / "refis.ico")
