"""Инструменты проверки доступности для UI-тестов.

* axe() — axe-core (Deque, MPL-2.0, tests/vendor/axe.min.js) по правилам WCAG 2.0–2.2 A/AA и best practices.
* pixel_contrast() — контраст по настоящим пикселям: снимок без текста даёт реальный фон под каждой надписью,
  в том числе на полупрозрачном «стекле» и градиентах, где axe не может посчитать фон сам.
* measure() — кнопки меньше 24×24 (WCAG 2.5.8) и текст мельче 12px (минимум Windows Fluent).
"""
import io
from pathlib import Path

from PIL import Image

COLLECT = r"""() => {
  const out = [];
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  for (const el of document.querySelectorAll('body *')) {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || +s.opacity === 0) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    if (op < .05) continue;
    const range = document.createRange(); range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    let clipText = false;
    for (let e = el; e && e !== document.body; e = e.parentElement) { const es = getComputedStyle(e); if (es.webkitBackgroundClip === 'text' || es.backgroundClip === 'text') { clipText = true; break; } }
    const fg = parse(el instanceof SVGElement ? s.fill : s.color); // у текста в SVG цвет — это fill
    if (!fg) continue;
    // .stars — значки-кнопки: для графики норма 3:1, и она проверяется отдельно
    const disabled = el.closest('button:disabled, [aria-disabled=true], input:disabled, .sr-only, .stars');
    if (disabled) continue;
    // текст, закрытый окном или просмотром, не проверяем — его сейчас не видно
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    if (top && !el.contains(top) && !top.contains(el)) continue;
    if (clipText) el.dataset.ck = '1';
    const fs = parseFloat(s.fontSize), fw = +s.fontWeight || 400;
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height, fg, op, clipText, large,
      d: (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '') + ' «' + el.textContent.trim().slice(0, 24) + '»') });
  }
  return out;
}"""

HIDE = """*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}
input::placeholder,textarea::placeholder{color:transparent!important}
[data-ck]{background:none!important}
svg text{fill:transparent!important}"""


def lum(c):
    v = [x / 255 for x in c[:3]]
    v = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in v]
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]


def ratio(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def pixel_contrast(pg, gradient_stops=None):
    items = pg.evaluate(COLLECT)
    h = pg.add_style_tag(content=HIDE)
    pg.wait_for_timeout(80)
    img = Image.open(io.BytesIO(pg.screenshot())).convert("RGB")
    pg.evaluate("(el) => el.remove()", h)
    sx = img.width / pg.viewport_size["width"]
    bad = []
    for it in items:
        box = [int(it["x"] * sx), int(it["y"] * sx), int((it["x"] + it["w"]) * sx), int((it["y"] + it["h"]) * sx)]
        box = [max(0, box[0]), max(0, box[1]), min(img.width, box[2]), min(img.height, box[3])]
        if box[2] - box[0] < 1 or box[3] - box[1] < 1:
            continue
        crop = img.crop(box).resize((min(24, box[2] - box[0]), min(8, box[3] - box[1])))
        px = [crop.getpixel((x, y)) for y in range(crop.height) for x in range(crop.width)]
        fgs = gradient_stops if it["clipText"] and gradient_stops else [it["fg"]]
        worst = 99
        for fg in fgs:
            a = fg[3] * it["op"] if len(fg) > 3 else it["op"]
            rs = sorted(ratio([fg[i] * a + p[i] * (1 - a) for i in range(3)], p) for p in px)
            worst = min(worst, rs[len(rs) // 10])  # 10-й перцентиль: худшие места фона под текстом
        need = 3 if it["large"] else 4.5
        if worst < need:
            bad.append((round(worst, 2), need, it["d"]))
    return sorted(set(bad))


AXE = (Path(__file__).parent / "vendor" / "axe.min.js").read_text(encoding="utf-8")
TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]


def axe(pg):
    if not pg.evaluate("() => !!window.axe"):
        pg.add_script_tag(content=AXE)
    return pg.evaluate("""async (tags) => {
      const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
      return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`); }""", TAGS)


def measure(pg):
    return pg.evaluate(r"""() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
      const small = [], tiny = [];
      for (const e of document.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, [role=button], [role=option], [role=treeitem], [tabindex="0"]')) {
        if (!vis(e) || e.closest('.sr-only')) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) small.push(`${e.tagName.toLowerCase()}#${e.id}.${e.className} «${(e.innerText || e.title || '').trim().slice(0, 16)}» ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
      for (const e of document.querySelectorAll('body *')) {
        if (!vis(e) || e.closest('.sr-only, svg') || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const fs = parseFloat(getComputedStyle(e).fontSize);
        if (fs < 12) tiny.push(`${e.tagName.toLowerCase()}.${e.className} ${fs}px «${e.textContent.trim().slice(0, 16)}»`);
      }
      return { small, tiny };
    }""")
