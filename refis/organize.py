"""Организация библиотеки и «умная» практика на её основе.

- поиск папок с картинками на диске;
- предложения тегов из имён файлов и папок;
- подсказки тегов для быстрой разметки;
- референс дня и задания, которые строятся из ваших тегов и истории практики.
"""
import datetime as dt
import math
import os
import random
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from . import db, media

router = APIRouter(prefix="/api")

DAY = 86400

# Слова из имён файлов, которые ничего не говорят о содержимом
STOP = {
    "img", "image", "images", "pic", "picture", "photo", "photos", "foto", "dsc", "dcim", "screenshot", "screen",
    "shot", "scr", "copy", "final", "new", "old", "edit", "edited", "version", "ver", "untitled", "file", "download",
    "downloaded", "pinterest", "pin", "pins", "jpg", "jpeg", "png", "webp", "gif", "mp4", "mov", "webm", "video",
    "vid", "clip", "frame", "the", "and", "for", "with", "from", "by", "of", "to", "in", "on", "at", "an", "a",
    "wallpaper", "hd", "full", "large", "small", "big", "original", "orig", "thumb", "resized", "export",
    "snapshot", "capture", "camera", "telegram", "whatsapp", "vk", "photo_", "pxl", "mvimg", "imgp", "dji",
    "копия", "скриншот", "снимок", "экрана", "изображение", "фото", "картинка", "новый", "новая", "без", "названия",
    "файл", "видео", "загрузка", "для", "это", "как", "что",
}
_HEXISH = set("abcdef")
_TOKEN = re.compile(r"[A-Za-zА-Яа-яЁё]+")
_CAMEL = re.compile(r"(?<=[a-zа-яё])(?=[A-ZА-ЯЁ])")


def tokens(text: str) -> list[str]:
    out = []
    for raw in _TOKEN.findall(_CAMEL.sub(" ", text)):
        t = raw.lower()
        if len(t) < 3 or len(t) > 24 or t in STOP:
            continue
        if set(t) <= _HEXISH and len(t) >= 3:      # обрывки хешей вроде «fbeac»
            continue
        if not re.search(r"[aeiouyаеёиоуыэюя]", t):  # нет гласных — скорее всего мусор
            continue
        out.append(t)
    return out


# ======================================================================= здоровье библиотеки

@router.get("/organize/health")
def health():
    conn = db.connect()
    c = conn.execute(
        "SELECT COUNT(*) total,"
        " COALESCE(SUM(NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id)), 0) untagged"
        " FROM media m WHERE missing = 0").fetchone()
    total, untagged = c["total"], c["untagged"]
    dupes = conn.execute(
        "SELECT COUNT(*) FROM (SELECT qhash FROM media WHERE qhash IS NOT NULL AND missing = 0"
        " GROUP BY qhash HAVING COUNT(*) > 1)").fetchone()[0]
    missing = conn.execute("SELECT COUNT(*) FROM media WHERE missing = 1").fetchone()[0]
    folders = [dict(r) for r in conn.execute(
        "SELECT f.id, f.path, f.kind, f.auto_tags, COUNT(m.id) count,"
        " COALESCE(SUM(m.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id)), 0) untagged"
        " FROM folders f LEFT JOIN media m ON m.folder_id = f.id AND m.missing = 0 GROUP BY f.id ORDER BY f.path")]
    tags = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
    pins = conn.execute("SELECT COUNT(*) FROM pin_sources").fetchone()[0]
    kinds = {r["kind"]: r["n"] for r in conn.execute("SELECT kind, COUNT(*) n FROM media WHERE missing = 0 GROUP BY kind")}
    tagged_share = (total - untagged) / total if total else 0
    # Оценка порядка: главное — теги; немного — отсутствие дублей и пропавших файлов
    score = 0
    if total:
        score = round(100 * (0.8 * tagged_share + 0.1 * (1 if not dupes else 0.3) + 0.1 * (1 if not missing else 0.3)))
    return {
        "total": total, "untagged": untagged, "tagged_share": tagged_share, "dupes": dupes, "missing": missing,
        "folders": folders, "tags": tags, "pin_sources": pins, "kinds": kinds, "score": score,
        "ready": total > 0 and tagged_share >= 0.5 and tags >= 3,
    }


# ======================================================================= поиск папок на диске

def _candidate_roots() -> list[Path]:
    home = Path.home()
    names = ["Pictures", "Изображения", "Desktop", "Рабочий стол", "Downloads", "Загрузки", "Documents",
             "Документы", "Videos", "Видео"]
    roots = [home / n for n in names]
    for od in home.glob("OneDrive*"):
        roots += [od / n for n in names]
    if os.name == "nt":  # другие диски: корневые папки, похожие на арт
        for letter in "DEFGH":
            drive = Path(f"{letter}:/")
            if drive.exists():
                roots.append(drive)
    seen, out = set(), []
    for r in roots:
        try:
            key = os.path.normcase(str(r.resolve()))
        except OSError:
            continue
        if key not in seen and r.is_dir():
            seen.add(key)
            out.append(r)
    return out


ARTY = re.compile(r"(art|арт|реф|ref|draw|рис|sketch|скетч|набросок|tutor|урок|курс|course|anatom|анатом|poz|поз|"
                  r"pinterest|inspir|вдохнов|study|штуд|paint|живоп|illustr|иллюстр|concept|концепт|"
                  r"character|персонаж|фото|photo|pictures|изображ|картин)", re.I)


def _count_media(path: Path, budget: dict, limit=4000) -> tuple[int, int]:
    """Сколько картинок и видео в папке (с ограничением по времени)."""
    imgs = vids = 0
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if not d.startswith((".", "$")) and d.lower() not in media.SKIP_DIRS
                       and d.lower() not in ("appdata", "node_modules", "windows", "program files")]
        for f in filenames:
            t = media.media_type(f)
            if t == "image":
                imgs += 1
            elif t == "video":
                vids += 1
        if imgs + vids > limit or time.monotonic() > budget["until"]:
            break
    return imgs, vids


@router.get("/organize/discover")
def discover():
    conn = db.connect()
    added = [os.path.normcase(r["path"]) for r in conn.execute("SELECT path FROM folders")]

    def covered(p: str) -> bool:
        p = os.path.normcase(p)
        return any(p == a or p.startswith(a + os.sep) or a.startswith(p + os.sep) for a in added)

    budget = {"until": time.monotonic() + 6}
    found = []
    for root in _candidate_roots():
        is_drive = len(root.parts) == 1
        try:
            subs = [d for d in root.iterdir() if d.is_dir() and not d.name.startswith((".", "$"))]
        except OSError:
            continue
        if is_drive:  # на дисках смотрим только папки с «художественными» названиями
            subs = [d for d in subs if ARTY.search(d.name)]
        for d in subs[:60]:
            if time.monotonic() > budget["until"]:
                break
            if covered(str(d)):
                continue
            imgs, vids = _count_media(d, budget)
            if imgs + vids >= 5:
                found.append({"path": str(d), "images": imgs, "videos": vids,
                              "kind": guess_kind(d.name), "arty": bool(ARTY.search(d.name))})
    found.sort(key=lambda f: (not f["arty"], -(f["images"] + f["videos"])))
    return found[:24]


def guess_kind(name: str) -> str:
    n = name.lower()
    if re.search(r"(tutor|урок|курс|course|lesson|обуч|разбор)", n):
        return "tutorial"
    if re.search(r"(мои|my|own|арты|arts|работ|works|portfolio|портфол|sketchbook|скетчбук)", n):
        return "own"
    return "ref"


# ======================================================================= предложения тегов

@router.get("/organize/tag-suggestions")
def tag_suggestions():
    conn = db.connect()
    existing = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM tags")}
    has = defaultdict(set)
    for r in conn.execute("SELECT mt.media_id, t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id"):
        has[r["media_id"]].add(r["name"])
    found: dict[str, set] = defaultdict(set)
    origin: dict[str, Counter] = defaultdict(Counter)
    rows = conn.execute("SELECT m.id, m.name, m.path, f.path root FROM media m JOIN folders f ON f.id = m.folder_id"
                        " WHERE m.missing = 0").fetchall()
    for r in rows:
        for t in set(tokens(r["name"])):
            found[t].add(r["id"]); origin[t]["name"] += 1
        rel = os.path.relpath(os.path.dirname(r["path"]), r["root"])
        if rel not in (".", ""):
            for part in Path(rel).parts:
                t = db.normalize_tag(part)
                if t and t.lower() not in STOP and not t.startswith("_"):
                    found[t].add(r["id"]); origin[t]["folder"] += 1
    min_count = 2 if len(rows) < 80 else 3
    out = []
    for t, ids in found.items():
        missing_ids = sorted(i for i in ids if t not in has[i])
        if len(missing_ids) < min_count:
            continue
        out.append({"tag": t, "count": len(missing_ids), "ids": missing_ids, "exists": t in existing,
                    "from": origin[t].most_common(1)[0][0], "sample": missing_ids[:4]})
    out.sort(key=lambda s: (-s["exists"], -s["count"]))
    return out[:40]


class ApplyIn(BaseModel):
    tag: str
    ids: list[int]


@router.post("/organize/apply")
def apply_suggestion(a: ApplyIn):
    conn = db.connect()
    tid = db.tag_id(conn, a.tag)
    conn.executemany("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", [(i, tid) for i in a.ids])
    return {"ok": True, "count": len(a.ids)}


# ======================================================================= быстрая разметка

@router.get("/organize/triage")
def triage(folder: int = 0, limit: int = 500):
    conn = db.connect()
    q = ("SELECT m.id, m.name, m.ext, m.type, m.kind, m.width, m.height, m.duration, m.thumb_state, m.path"
         " FROM media m WHERE m.missing = 0 AND NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id)")
    args: list = []
    if folder:
        q += " AND m.folder_id = ?"
        args.append(folder)
    q += " ORDER BY m.path LIMIT ?"
    return [dict(r) for r in conn.execute(q, args + [limit])]


@router.get("/organize/suggest/{mid}")
def suggest_for(mid: int):
    """Подсказки тегов для одного файла: соседи по папке, имя файла, дубликаты, популярные."""
    conn = db.connect()
    m = conn.execute("SELECT * FROM media WHERE id = ?", (mid,)).fetchone()
    if not m:
        return []
    score: Counter = Counter()
    why: dict[str, str] = {}
    folder = os.path.dirname(m["path"])
    prefix = folder + os.sep
    for r in conn.execute(  # только соседи в этой же папке, без вложенных
            "SELECT t.name, COUNT(*) n FROM media x JOIN media_tags mt ON mt.media_id = x.id JOIN tags t ON t.id = mt.tag_id"
            " WHERE substr(x.path, 1, ?) = ? AND instr(substr(x.path, ?), ?) = 0 AND x.id != ? GROUP BY t.id",
            (len(prefix), prefix, len(prefix) + 1, os.sep, mid)):
        score[r["name"]] += 3 + r["n"]; why.setdefault(r["name"], "в этой папке")
    all_tags = [r["name"] for r in conn.execute("SELECT name FROM tags")]
    toks = set(tokens(m["name"])) | {db.normalize_tag(p) for p in Path(folder).parts[-2:]}
    for t in all_tags:
        last = t.split("/")[-1]
        if last in toks or any(len(k) > 3 and (k.startswith(last) or last.startswith(k)) for k in toks):
            score[t] += 6; why[t] = "по имени файла"
    if m["qhash"]:
        for r in conn.execute(
                "SELECT t.name FROM media x JOIN media_tags mt ON mt.media_id = x.id JOIN tags t ON t.id = mt.tag_id"
                " WHERE x.qhash = ? AND x.id != ?", (m["qhash"], mid)):
            score[r["name"]] += 8; why[r["name"]] = "у дубликата"
    for r in conn.execute("SELECT t.name, COUNT(*) n FROM tags t JOIN media_tags mt ON mt.tag_id = t.id"
                          " GROUP BY t.id ORDER BY n DESC LIMIT 12"):
        score[r["name"]] += 1 + math.log(r["n"]); why.setdefault(r["name"], "популярный")
    new_words = [t for t in tokens(m["name"]) if t not in all_tags][:3]
    out = [{"tag": t, "why": why[t]} for t, _ in score.most_common(12)]
    out += [{"tag": t, "why": "новый, из имени"} for t in new_words]
    return out


# ======================================================================= подбор для практики

def _rng(n: int, salt: int = 0) -> random.Random:
    return random.Random(int(dt.date.today().strftime("%Y%m%d")) * 1000 + n * 7 + salt)


def _weighted(rnd: random.Random, items: list, weights: list):
    if not items:
        return None
    return rnd.choices(items, weights=weights, k=1)[0]


def topic_stats(conn, kind: str | None = None, min_images: int = 1) -> list[dict]:
    """Теги с картинками + сколько по ним практиковались за 2 недели."""
    since = time.time() - 14 * DAY
    practiced = Counter(r["tag"] for r in conn.execute(
        "SELECT tag FROM practice_log WHERE ts >= ? AND tag != ''", (since,)))
    q = ("SELECT t.name, COUNT(*) n FROM tags t JOIN media_tags mt ON mt.tag_id = t.id JOIN media m ON m.id = mt.media_id"
         " WHERE m.missing = 0 AND m.type = 'image'")
    args: list = []
    if kind:
        q += " AND m.kind = ?"
        args.append(kind)
    q += " GROUP BY t.id HAVING n >= ?"
    return [{"tag": r["name"], "count": r["n"], "practiced": practiced[r["name"]]}
            for r in conn.execute(q, args + [min_images])]


def pick_topic(rnd, topics: list[dict]):
    """Чаще — большие темы, по которым давно не практиковались."""
    return _weighted(rnd, topics, [math.sqrt(t["count"]) / (1 + 2 * t["practiced"]) for t in topics])


def pick_images(rnd, conn, tag: str | None = None, kind: str | None = None, k: int = 1, where: str = "") -> list[dict]:
    q = ("SELECT m.id, m.name, m.width, m.height, m.rating, m.favorite, m.last_viewed, m.kind, m.mtime FROM media m"
         " WHERE m.missing = 0 AND m.type = 'image'" + where)
    args: list = []
    if tag:
        q += (" AND EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = m.id"
              " AND (t.name = ? OR t.name LIKE ?))")
        args += [tag, tag + "/%"]
    if kind:
        q += " AND m.kind = ?"
        args.append(kind)
    rows = [dict(r) for r in conn.execute(q, args)]
    now = time.time()
    out = []
    for _ in range(min(k, len(rows))):
        w = [(1 + 2 * r["favorite"] + 0.5 * r["rating"]) * (0.35 if r["last_viewed"] and now - r["last_viewed"] < 14 * DAY else 1)
             for r in rows]
        r = _weighted(rnd, rows, w)
        out.append(r)
        rows.remove(r)
    return out


@router.get("/today")
def today(n: int = 0):
    """Референс дня: тема дня из ваших тегов → лучшая картинка в ней."""
    conn = db.connect()
    rnd = _rng(n, 1)
    topics = topic_stats(conn, "ref") or topic_stats(conn)
    topic = pick_topic(rnd, topics)
    if topic:
        imgs = pick_images(rnd, conn, tag=topic["tag"], kind="ref") or pick_images(rnd, conn, tag=topic["tag"])
        reason = (f"Тема дня — #{topic['tag']}: по ней вы давно не практиковались" if not topic["practiced"]
                  else f"Тема дня — #{topic['tag']}")
    else:
        imgs = pick_images(rnd, conn, kind="ref") or pick_images(rnd, conn)
        reason = "Пока случайно: разметьте файлы тегами, и подбор станет точнее"
    if not imgs:
        return {"media": None}
    from .server import get_media
    return {"media": get_media(conn, imgs[0]["id"]), "tag": topic["tag"] if topic else "", "reason": reason}


RULES = [
    "только 3 тона", "без ластика", "одной непрерывной линией", "сначала силуэт, потом детали",
    "только крупные формы", "без контурных линий", "только прямые линии", "максимум 20 линий",
    "только светотень, без линий", "в двух цветах", "широкой кистью", "начни с самых тёмных пятен",
    "сначала простые объёмы: шар, куб, цилиндр", "не отрывая взгляда от референса", "в квадратном формате",
]


@router.get("/challenge")
def challenge(n: int = 0):
    """Задание, собранное из вашей библиотеки. Тип выбирается из того, что в ней есть."""
    conn = db.connect()
    rnd = _rng(n, 2)
    topics = topic_stats(conn)
    big = [t for t in topics if t["count"] >= 6]
    own_old = conn.execute("SELECT COUNT(*) FROM media WHERE missing = 0 AND type = 'image' AND kind = 'own' AND mtime < ?",
                           (time.time() - 60 * DAY,)).fetchone()[0]
    best = conn.execute("SELECT COUNT(*) FROM media WHERE missing = 0 AND type = 'image' AND (favorite = 1 OR rating >= 4)"
                        ).fetchone()[0]
    new_pins = conn.execute("SELECT COUNT(*) FROM pins WHERE status = 'new'").fetchone()[0]
    options = []
    if topics:
        options.append(("tag", 4))
    if big:
        options.append(("series", 2))
    if best:
        options.append(("study", 2))
    if own_old:
        options.append(("redraw", 1.5))
    if new_pins:
        options.append(("pin", 1.5))
    if not options:
        return {"ctype": "none", "reason": "Добавьте теги к файлам — задания строятся из ваших тем и референсов."}
    ctype = _weighted(rnd, [o[0] for o in options], [o[1] for o in options])
    rule = rnd.choice(RULES)
    if ctype == "series":
        t = pick_topic(rnd, big)
        imgs = pick_images(rnd, conn, tag=t["tag"], k=10)
        per = rnd.choice([45, 60, 90, 120])
        return {"ctype": ctype, "tag": t["tag"], "title": f"Серия набросков: #{t['tag']}",
                "text": f"{len(imgs)} референсов из темы «{t['tag']}» по {per} секунд — разогрев руки и глаза.",
                "rule": "не детализируй, лови движение и пропорции", "minutes": round(len(imgs) * per / 60),
                "per": per, "images": [{"id": i["id"]} for i in imgs]}
    if ctype == "study":
        imgs = pick_images(rnd, conn, where=" AND (m.favorite = 1 OR m.rating >= 4)")
        return {"ctype": ctype, "tag": "", "title": "Мастер-штудия",
                "text": f"Скопируй как можно точнее свой любимый референс «{imgs[0]['name']}».",
                "rule": "сначала пропорции и большие тени, детали — в конце", "minutes": rnd.choice([30, 45, 60]),
                "images": [{"id": imgs[0]["id"]}]}
    if ctype == "redraw":
        imgs = pick_images(rnd, conn, kind="own", where=f" AND m.mtime < {time.time() - 60 * DAY}")
        age = (time.time() - imgs[0]["mtime"]) / DAY
        when = f"{round(age / 30)} мес. назад" if age < 365 else f"{age / 365:.1f} г. назад"
        return {"ctype": ctype, "tag": "", "title": "Перерисуй свою работу",
                "text": f"«{imgs[0]['name']}» — нарисована {when}. Нарисуй заново и сравни, как ты вырос(ла).",
                "rule": "не копируй старую — нарисуй с нуля, глядя на неё", "minutes": rnd.choice([30, 45, 60]),
                "images": [{"id": imgs[0]["id"]}]}
    if ctype == "pin":
        p = conn.execute("SELECT p.id, p.title, s.title board FROM pins p JOIN pin_sources s ON s.id = p.source_id"
                         " WHERE p.status = 'new' ORDER BY random() LIMIT 1").fetchone()
        return {"ctype": ctype, "tag": "", "title": "Свежий пин",
                "text": f"Новый референс с доски «{p['board']}»" + (f": {p['title']}" if p["title"] else "") + ".",
                "rule": rule, "minutes": rnd.choice([10, 15, 20]), "images": [{"pin": p["id"]}]}
    t = pick_topic(rnd, topics)
    imgs = pick_images(rnd, conn, tag=t["tag"])
    return {"ctype": "tag", "tag": t["tag"], "title": f"Нарисуй: #{t['tag']}",
            "text": (f"Тема из вашей библиотеки ({t['count']} референсов)"
                     + ("; давно не практиковались" if not t["practiced"] else "") + "."),
            "rule": rule, "minutes": rnd.choice([10, 15, 20, 30]), "images": [{"id": i["id"]} for i in imgs]}
