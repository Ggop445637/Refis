"""HTTP API + раздача интерфейса."""
import datetime as dt
import io
import json
import mimetypes
import os
import uuid
import re
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .i18n import tr
from . import __version__, db, media, organize, packs, pinterest, profile, security, system

STATIC = Path(__file__).resolve().parent / "static"

# Реестр Windows иногда отдаёт .js как text/plain — тогда ES-модули не грузятся.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

@asynccontextmanager
async def lifespan(_app):
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    db.ASSET_DIR.mkdir(parents=True, exist_ok=True)
    system.apply_pending_restore()
    db.init()
    system.startup()
    # пересканировать папки в фоне: подхватить новые/удалённые файлы
    threading.Thread(target=media.scan_all, daemon=True).start()
    media.thumbs.kick()
    pinterest.background_sync()
    yield


app = FastAPI(title="Refis", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.middleware("http")(security.guard)


@app.get("/api/session")
def session():
    """Токен для изменяющих запросов. Чужие сайты прочитать ответ не могут (нет CORS)."""
    return {"token": security.TOKEN, "version": __version__}


# ---------------------------------------------------------------- helpers

def row_dict(r) -> dict:
    return {k: r[k] for k in r.keys()}


def media_tags(conn, ids: list[int]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {i: [] for i in ids}
    for chunk in range(0, len(ids), 900):
        part = ids[chunk:chunk + 900]
        q = ("SELECT mt.media_id, t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id "
             f"WHERE mt.media_id IN ({','.join('?' * len(part))}) ORDER BY t.name")
        for r in conn.execute(q, part):
            out[r["media_id"]].append(r["name"])
    return out


def get_media(conn, mid: int) -> dict:
    r = conn.execute("SELECT * FROM media WHERE id = ?", (mid,)).fetchone()
    if not r:
        raise HTTPException(404, tr("Файл не найден в каталоге"))
    d = row_dict(r)
    d["tags"] = media_tags(conn, [mid])[mid]
    if d["qhash"]:
        d["duplicates"] = [row_dict(x) for x in conn.execute(
            "SELECT id, path FROM media WHERE qhash = ? AND id != ?", (d["qhash"], mid))]
    return d


_TOKEN = re.compile(r'(-?)#"([^"]+)"|(-?)#(\S+)|(-?)"([^"]+)"|(-?)(\S+)')


def parse_query(q: str):
    inc, exc, words, nwords = [], [], [], []
    for m in _TOKEN.finditer(q or ""):
        if m[2] or m[4]:
            (exc if (m[1] or m[3]) else inc).append(db.normalize_tag(m[2] or m[4]))
        else:
            w = m[6] or m[8]
            if w:
                (nwords if (m[5] or m[7]) else words).append(w)
    return inc, exc, words, nwords


def tag_clause(name: str) -> tuple[str, list]:
    # тег «анатомия» включает и вложенные «анатомия/руки»
    return ("EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id "
            "WHERE mt.media_id = m.id AND (t.name = ? OR t.name LIKE ? ESCAPE '\\'))",
            [name, name.replace("%", r"\%").replace("_", r"\_") + "/%"])


SORTS = {
    "new": "m.added_at DESC, m.id DESC",
    "old": "m.added_at ASC, m.id ASC",
    "name": "m.name COLLATE NOCASE ASC",
    "mtime": "m.mtime DESC",
    "rating": "m.rating DESC, m.added_at DESC",
    "size": "m.size DESC",
    "duration": "m.duration DESC",
    "random": "random()",
}


# ---------------------------------------------------------------- status / folders

@app.get("/api/status")
def status():
    conn = db.connect()
    c = conn.execute(
        "SELECT COUNT(*) total, SUM(type='image') images, SUM(type='video') videos, SUM(missing) missing"
        " FROM media").fetchone()
    return {"scan": media.scan_status, "thumbs_pending": media.thumbs.pending, **row_dict(c),
            "ffmpeg": bool(media.ffmpeg_exe())}


class FolderIn(BaseModel):
    path: str
    kind: str = "ref"
    auto_tags: bool = True


class FolderPatch(BaseModel):
    kind: str | None = None
    auto_tags: bool | None = None
    apply_kind: bool = False  # проставить новый тип всем файлам папки


@app.get("/api/folders")
def folders():
    conn = db.connect()
    return [row_dict(r) for r in conn.execute(
        "SELECT f.*, (SELECT COUNT(*) FROM media m WHERE m.folder_id = f.id) count FROM folders f ORDER BY path")]


@app.post("/api/folders")
def add_folder(f: FolderIn):
    path = os.path.abspath(os.path.expanduser(f.path.strip().strip('"')))
    if not os.path.isdir(path):
        raise HTTPException(400, tr("Папка не найдена: {path}", path=path))
    if f.kind not in db.KINDS:
        raise HTTPException(400, tr("Неизвестный тип"))
    conn = db.connect()
    for r in conn.execute("SELECT path FROM folders"):
        a, b = os.path.normcase(r["path"]), os.path.normcase(path)
        if a == b or b.startswith(a + os.sep) or a.startswith(b + os.sep):
            raise HTTPException(400, tr("Пересекается с уже добавленной папкой: {path}", path=r["path"]))
    fid = conn.execute("INSERT INTO folders(path, kind, auto_tags) VALUES (?,?,?)",
                       (path, f.kind, int(f.auto_tags))).lastrowid
    threading.Thread(target=media.scan_folder, args=(fid,), daemon=True).start()
    return {"id": fid, "path": path}


@app.patch("/api/folders/{fid}")
def patch_folder(fid: int, p: FolderPatch):
    conn = db.connect()
    if p.kind is not None:
        if p.kind not in db.KINDS:
            raise HTTPException(400, tr("Неизвестный тип"))
        conn.execute("UPDATE folders SET kind = ? WHERE id = ?", (p.kind, fid))
        if p.apply_kind:
            conn.execute("UPDATE media SET kind = ? WHERE folder_id = ?", (p.kind, fid))
    if p.auto_tags is not None:
        conn.execute("UPDATE folders SET auto_tags = ? WHERE id = ?", (int(p.auto_tags), fid))
    return {"ok": True}


@app.delete("/api/folders/{fid}")
def delete_folder(fid: int):
    """Убирает папку из каталога. Файлы на диске НЕ трогаются."""
    conn = db.connect()
    ids = [r[0] for r in conn.execute("SELECT id FROM media WHERE folder_id = ?", (fid,))]
    conn.execute("DELETE FROM folders WHERE id = ?", (fid,))
    for i in ids:
        media.thumb_path(i).unlink(missing_ok=True)
    db.cleanup_tags(conn)
    return {"ok": True}


@app.post("/api/folders/{fid}/scan")
def scan_one(fid: int):
    threading.Thread(target=media.scan_folder, args=(fid,), daemon=True).start()
    return {"ok": True}


@app.post("/api/scan")
def scan_everything():
    threading.Thread(target=media.scan_all, daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- media

@app.get("/api/media")
def list_media(q: str = "", kind: str = "", type: str = "", folder: int = 0, fav: bool = False,
               untagged: bool = False, dupes: bool = False, missing: bool = False, orient: str = "",
               min_rating: int = 0, tags: str = "", ntags: str = "", sort: str = "new", offset: int = 0, limit: int = 300):
    conn = db.connect()
    inc, exc, words, nwords = parse_query(q)
    inc += [db.normalize_tag(t) for t in tags.split(",") if t.strip()]
    exc += [db.normalize_tag(t) for t in ntags.split(",") if t.strip()]
    where, args = [], []
    where.append("m.missing = 1" if missing else "m.missing = 0")
    if kind in db.KINDS:
        where.append("m.kind = ?"); args.append(kind)
    if type in ("image", "video"):
        where.append("m.type = ?"); args.append(type)
    if folder:
        where.append("m.folder_id = ?"); args.append(folder)
    if fav:
        where.append("m.favorite = 1")
    if min_rating:
        where.append("m.rating >= ?"); args.append(min_rating)
    if untagged:
        where.append("NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id)")
    if dupes:
        where.append("m.qhash IN (SELECT qhash FROM media WHERE qhash IS NOT NULL AND missing = 0 "
                     "GROUP BY qhash HAVING COUNT(*) > 1)")
    if orient == "landscape":
        where.append("m.width > m.height * 1.1")
    elif orient == "portrait":
        where.append("m.height > m.width * 1.1")
    elif orient == "square":
        where.append("m.width BETWEEN m.height * 0.9 AND m.height * 1.1")
    for t in inc:
        c, a = tag_clause(t); where.append(c); args += a
    for t in exc:
        c, a = tag_clause(t); where.append("NOT " + c); args += a
    text = "(m.name || ' ' || m.title || ' ' || m.notes || ' ' || m.source || ' ' || m.path)"
    for w in words:
        where.append(f"{text} LIKE ?"); args.append(f"%{w}%")
    for w in nwords:
        where.append(f"{text} NOT LIKE ?"); args.append(f"%{w}%")

    sql_where = " AND ".join(where)
    total = conn.execute(f"SELECT COUNT(*) FROM media m WHERE {sql_where}", args).fetchone()[0]
    order = "m.qhash, m.id" if dupes else SORTS.get(sort, SORTS["new"])
    rows = conn.execute(
        "SELECT m.id, m.name, m.ext, m.type, m.kind, m.width, m.height, m.duration, m.rating, m.favorite,"
        f" m.thumb_state, m.qhash FROM media m WHERE {sql_where} ORDER BY {order} LIMIT ? OFFSET ?",
        args + [min(limit, 2000), offset]).fetchall()
    items = [row_dict(r) for r in rows]
    tagmap = media_tags(conn, [i["id"] for i in items])
    for i in items:
        i["tags"] = tagmap[i["id"]]
    return {"total": total, "items": items}


@app.get("/api/media/{mid}")
def one_media(mid: int):
    return get_media(db.connect(), mid)


class MediaPatch(BaseModel):
    title: str | None = None
    notes: str | None = None
    source: str | None = None
    rating: int | None = None
    favorite: bool | None = None
    kind: str | None = None
    tags: list[str] | None = None


@app.patch("/api/media/{mid}")
def patch_media(mid: int, p: MediaPatch):
    conn = db.connect()
    fields = p.model_dump(exclude_none=True)
    tags = fields.pop("tags", None)
    if "kind" in fields and fields["kind"] not in db.KINDS:
        raise HTTPException(400, tr("Неизвестный тип"))
    if "rating" in fields:
        fields["rating"] = max(0, min(5, fields["rating"]))
    if fields:
        conn.execute(f"UPDATE media SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                     [*map(lambda v: int(v) if isinstance(v, bool) else v, fields.values()), mid])
    if tags is not None:
        conn.execute("DELETE FROM media_tags WHERE media_id = ?", (mid,))
        for t in {db.normalize_tag(t) for t in tags} - {""}:
            conn.execute("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", (mid, db.tag_id(conn, t)))
        db.cleanup_tags(conn)
    return get_media(conn, mid)


class Bulk(BaseModel):
    ids: list[int]
    add_tags: list[str] = []
    remove_tags: list[str] = []
    kind: str | None = None
    favorite: bool | None = None
    rating: int | None = None
    forget: bool = False  # убрать записи из каталога (файлы не удаляются)


@app.post("/api/media/bulk")
def bulk(b: Bulk):
    conn = db.connect()
    conn.execute("BEGIN")
    try:
        if b.forget:
            _drop_media(conn, b.ids)
        else:
            for t in {db.normalize_tag(t) for t in b.add_tags} - {""}:
                tid = db.tag_id(conn, t)
                conn.executemany("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", [(i, tid) for i in b.ids])
            for t in b.remove_tags:
                r = conn.execute("SELECT id FROM tags WHERE name = ?", (db.normalize_tag(t),)).fetchone()
                if r:
                    conn.executemany("DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?",
                                     [(i, r["id"]) for i in b.ids])
            if b.kind in db.KINDS:
                conn.executemany("UPDATE media SET kind = ? WHERE id = ?", [(b.kind, i) for i in b.ids])
            if b.favorite is not None:
                conn.executemany("UPDATE media SET favorite = ? WHERE id = ?",
                                 [(int(b.favorite), i) for i in b.ids])
            if b.rating is not None:
                conn.executemany("UPDATE media SET rating = ? WHERE id = ?",
                                 [(max(0, min(5, b.rating)), i) for i in b.ids])
        db.cleanup_tags(conn)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return {"ok": True}


def _drop_media(conn, ids: list[int]) -> None:
    """Убирает записи из каталога вместе с превью; пины с Pinterest больше не ссылаются на них."""
    conn.executemany("DELETE FROM media WHERE id = ?", [(i,) for i in ids])
    conn.executemany("UPDATE pins SET status = 'hidden', media_id = NULL WHERE media_id = ?", [(i,) for i in ids])
    gone = set(ids)
    for r in conn.execute("SELECT id, data FROM boards").fetchall():  # и с досок, чтобы не было пустых рамок
        data = json.loads(r["data"])
        items = [i for i in data.get("items", []) if not (i.get("type") == "media" and i.get("mid") in gone)]
        if len(items) != len(data.get("items", [])):
            data["items"] = items
            conn.execute("UPDATE boards SET data = ? WHERE id = ?", (json.dumps(data, ensure_ascii=False), r["id"]))
    for i in ids:
        media.thumb_path(i).unlink(missing_ok=True)


class Ids(BaseModel):
    ids: list[int]


@app.post("/api/media/trash")
def trash(b: Ids):
    """Удаляет файлы в Корзину (их можно вернуть) и убирает их из каталога."""
    conn = db.connect()
    done, failed = [], []
    for mid in dict.fromkeys(b.ids):
        r = conn.execute("SELECT path FROM media WHERE id = ?", (mid,)).fetchone()
        if not r:
            continue
        try:
            if os.path.exists(r["path"]):
                media.trash_file(r["path"])
        except Exception as e:  # файл открыт в другой программе, нет прав и т. п.
            failed.append({"id": mid, "name": os.path.basename(r["path"]), "error": str(e)[:200]})
            continue
        done.append(mid)
    if done:
        conn.execute("BEGIN")
        _drop_media(conn, done)
        db.cleanup_tags(conn)
        conn.execute("COMMIT")
    return {"ids": done, "failed": failed}


@app.post("/api/media/{mid}/frame")
def save_frame(mid: int, file: UploadFile = File(...), t: float = Form(0)):
    """Кадр из видео (снимается в окне просмотра) становится отдельным референсом с тегами видео."""
    from PIL import Image
    conn = db.connect()
    r = conn.execute("SELECT * FROM media WHERE id = ?", (mid,)).fetchone()
    if not r or r["type"] != "video":
        raise HTTPException(404)
    folder = conn.execute("SELECT * FROM folders WHERE id = ?", (r["folder_id"],)).fetchone()
    data = file.file.read()
    try:
        fmt = Image.open(io.BytesIO(data)).format
    except Exception:
        fmt = None
    if fmt not in ("JPEG", "PNG"):
        raise HTTPException(400, tr("Не удалось сохранить кадр"))
    t = max(0.0, t)
    m, sec = divmod(t, 60)
    stamp = f"{int(m)}:{sec:04.1f}"
    dest = media.target_dir(folder["path"], f"{tr('Кадры')}/{r['name']}")
    target = media.unique_path(dest, f"{r['name']} {int(m):02d}-{sec:04.1f}.{'png' if fmt == 'PNG' else 'jpg'}")
    with open(target, "wb") as out:
        out.write(data)
    tags = [x["name"] for x in conn.execute(
        "SELECT t.name FROM tags t JOIN media_tags mt ON mt.tag_id = t.id WHERE mt.media_id = ?", (mid,))]
    new = media.register_file(conn, folder, target, "ref", tags + [tr("кадр")], f"{r['name']} · {stamp}")
    media.thumbs.kick()
    return {"id": new, "path": target}


@app.get("/api/thumb/{mid}")
def thumb(mid: int):
    p = media.thumb_path(mid)
    if not p.exists():
        r = db.connect().execute("SELECT id, path, type FROM media WHERE id = ?", (mid,)).fetchone()
        if not r:
            raise HTTPException(404)
        try:
            media.make_thumb(r)
        except Exception:
            raise HTTPException(404)
        if not p.exists():
            raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "max-age=60"})


@app.get("/api/file/{mid}")
def file(mid: int):
    r = db.connect().execute("SELECT path FROM media WHERE id = ?", (mid,)).fetchone()
    if not r or not os.path.exists(r["path"]):
        raise HTTPException(404, tr("Файл не найден на диске"))
    return FileResponse(r["path"])


def _path_of(mid: int) -> str:
    r = db.connect().execute("SELECT path FROM media WHERE id = ?", (mid,)).fetchone()
    if not r:
        raise HTTPException(404)
    return r["path"]


@app.post("/api/media/{mid}/reveal")
def reveal(mid: int):
    _reveal(_path_of(mid))
    return {"ok": True}


def _reveal(path: str) -> None:
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path)])


@app.post("/api/media/{mid}/open")
def open_external(mid: int):
    path = _path_of(mid)
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path])
    return {"ok": True}


# ---------------------------------------------------------------- upload (drag & drop)

_safe_name = media.safe_name


@app.post("/api/upload")
def upload(files: list[UploadFile] = File(...), folder_id: int = Form(...), subdir: str = Form(""),
           tags: str = Form(""), kind: str = Form("")):
    conn = db.connect()
    folder = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if not folder:
        raise HTTPException(400, tr("Папка не найдена"))
    dest = media.target_dir(folder["path"], subdir or tr("_Входящие"))
    tag_list = [t for t in (db.normalize_tag(x) for x in tags.split(",")) if t]
    added = []
    for f in files:
        if not media.media_type(f.filename or ""):
            continue
        target = media.unique_path(dest, f.filename or "file")
        with open(target, "wb") as out:
            while chunk := f.file.read(1 << 20):
                out.write(chunk)
        mid = media.register_file(conn, folder, target, kind, tag_list)
        if mid:
            added.append(mid)
    media.thumbs.kick()
    return {"added": added}


# ---------------------------------------------------------------- tags / saved searches

@app.get("/api/tags")
def tags():
    return [row_dict(r) for r in db.connect().execute(
        "SELECT t.id, t.name, COUNT(m.id) count FROM tags t JOIN media_tags mt ON mt.tag_id = t.id "
        "JOIN media m ON m.id = mt.media_id AND m.missing = 0 GROUP BY t.id ORDER BY t.name")]


class TagPatch(BaseModel):
    name: str


@app.patch("/api/tags/{tid}")
def rename_tag(tid: int, p: TagPatch):
    """Переименование; если тег с таким именем уже есть — теги сливаются."""
    conn = db.connect()
    name = db.normalize_tag(p.name)
    if not name:
        raise HTTPException(400, tr("Пустое имя"))
    other = conn.execute("SELECT id FROM tags WHERE name = ? AND id != ?", (name, tid)).fetchone()
    if other:
        conn.execute("INSERT OR IGNORE INTO media_tags SELECT media_id, ? FROM media_tags WHERE tag_id = ?",
                     (other["id"], tid))
        conn.execute("DELETE FROM tags WHERE id = ?", (tid,))
    else:
        conn.execute("UPDATE tags SET name = ? WHERE id = ?", (name, tid))
    return {"ok": True}


@app.delete("/api/tags/{tid}")
def delete_tag(tid: int):
    db.connect().execute("DELETE FROM tags WHERE id = ?", (tid,))
    return {"ok": True}


class SavedIn(BaseModel):
    name: str
    query: dict


@app.get("/api/saved")
def saved():
    return [{"id": r["id"], "name": r["name"], "query": json.loads(r["query"])}
            for r in db.connect().execute("SELECT * FROM saved_searches ORDER BY name")]


@app.post("/api/saved")
def add_saved(s: SavedIn):
    sid = db.connect().execute("INSERT INTO saved_searches(name, query) VALUES (?, ?)",
                               (s.name.strip() or tr("Поиск"), json.dumps(s.query, ensure_ascii=False))).lastrowid
    return {"id": sid}


@app.delete("/api/saved/{sid}")
def delete_saved(sid: int):
    db.connect().execute("DELETE FROM saved_searches WHERE id = ?", (sid,))
    return {"ok": True}


# ---------------------------------------------------------------- просмотры / палитра

@app.post("/api/media/{mid}/viewed")
def viewed(mid: int):
    db.connect().execute("UPDATE media SET last_viewed = ?, view_count = view_count + 1 WHERE id = ?",
                         (time.time(), mid))
    return {"ok": True}


@app.get("/api/media/{mid}/palette")
def palette(mid: int, n: int = 6):
    from PIL import Image
    p = media.thumb_path(mid)
    if not p.exists():
        thumb(mid)
    with Image.open(p) as im:
        im = im.convert("RGB")
        im.thumbnail((160, 160))
        q = im.quantize(colors=24, method=Image.Quantize.MEDIANCUT)
        pal = q.getpalette()
        counts = sorted(q.getcolors(), reverse=True)
        total = im.width * im.height
    # берём самые частые цвета, пропуская слишком похожие на уже выбранные
    out: list[dict] = []
    for cnt, idx in counts:
        rgb = pal[idx * 3: idx * 3 + 3]
        near = next((o for o in out if sum((a - b) ** 2 for a, b in zip(o["rgb"], rgb)) < 30 ** 2), None)
        if near:
            near["share"] += cnt / total
            continue
        out.append({"rgb": rgb, "share": cnt / total})
        if len(out) >= max(2, min(n, 12)):
            break
    return [{"hex": "#%02x%02x%02x" % tuple(o["rgb"]), "share": o["share"]} for o in out]


# ---------------------------------------------------------------- «Сегодня»: референс дня и статистика

@app.get("/api/stats")
def stats():
    conn = db.connect()
    c = row_dict(conn.execute(
        "SELECT COUNT(*) total, COALESCE(SUM(type='video'),0) videos, COALESCE(SUM(favorite),0) favorites,"
        " COALESCE(SUM(kind='own'),0) own,"
        " COALESCE(SUM(NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id)),0) untagged"
        " FROM media m WHERE missing = 0").fetchone())
    c["tags"] = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]

    # практика: тепловая карта за 16 недель, серия дней подряд, минуты за неделю
    today_ = dt.date.today()
    start = today_ - dt.timedelta(days=16 * 7 - 1)
    days: dict[str, dict] = {}
    for r in conn.execute("SELECT ts, count, seconds FROM practice_log WHERE ts >= ?",
                          (time.mktime(start.timetuple()),)):
        d = dt.date.fromtimestamp(r["ts"]).isoformat()
        e = days.setdefault(d, {"count": 0, "seconds": 0})
        e["count"] += r["count"]
        e["seconds"] += r["seconds"]
    streak, d = 0, today_
    if d.isoformat() not in days:
        d -= dt.timedelta(days=1)  # сегодня ещё можно успеть — серия не прерывается
    while d.isoformat() in days:
        streak += 1
        d -= dt.timedelta(days=1)
    week = sum(v["seconds"] for k, v in days.items() if dt.date.fromisoformat(k) > today_ - dt.timedelta(days=7))
    c["practice"] = {"days": days, "streak": streak, "week_minutes": round(week / 60),
                     "total_sessions": conn.execute("SELECT COUNT(*) FROM practice_log").fetchone()[0],
                     "start": start.isoformat()}

    cols = ("SELECT m.id, m.name, m.ext, m.type, m.kind, m.width, m.height, m.duration, m.rating, m.favorite,"
            " m.thumb_state FROM media m WHERE m.missing = 0 ")
    c["recent"] = [row_dict(r) for r in conn.execute(cols + "ORDER BY added_at DESC LIMIT 14")]
    month_ago = time.time() - 30 * 86400
    c["forgotten"] = [row_dict(r) for r in conn.execute(
        cols + "AND m.type = 'image' AND (m.last_viewed IS NULL OR m.last_viewed < ?) "
        "ORDER BY (m.favorite * 3 + m.rating) DESC, random() LIMIT 10", (month_ago,))]
    c["top_tags"] = [row_dict(r) for r in conn.execute(
        "SELECT t.name, COUNT(*) count FROM tags t JOIN media_tags mt ON mt.tag_id = t.id "
        "GROUP BY t.id ORDER BY count DESC LIMIT 30")]
    return c


class PracticeIn(BaseModel):
    kind: str = "gesture"
    count: int = 0
    seconds: float = 0
    prompt: str = ""
    media_id: int | None = None
    tag: str = ""
    ctype: str = ""


@app.post("/api/practice")
def log_practice(p: PracticeIn):
    db.connect().execute(
        "INSERT INTO practice_log(ts, kind, count, seconds, prompt, media_id, tag, ctype) VALUES (?,?,?,?,?,?,?,?)",
        (time.time(), p.kind, p.count, p.seconds, p.prompt, p.media_id, db.normalize_tag(p.tag), p.ctype))
    return {"ok": True}


@app.get("/api/practice")
def practice_history(limit: int = 30):
    return [row_dict(r) for r in db.connect().execute(
        "SELECT * FROM practice_log ORDER BY ts DESC LIMIT ?", (limit,))]


# ---------------------------------------------------------------- доски референсов

class BoardIn(BaseModel):
    name: str | None = None
    data: dict | None = None


def _board_preview(data: dict, known: set[int]) -> list[str]:
    items = [i for i in data.get("items", []) if i.get("type") == "asset" or (i.get("type") == "media" and i.get("mid") in known)]
    items.sort(key=lambda i: -(i.get("w", 0) * i.get("h", 0)))
    return [i["src"] for i in items[:4] if i.get("src")]


@app.get("/api/boards")
def boards():
    out, conn = [], db.connect()
    known = {r[0] for r in conn.execute("SELECT id FROM media")}
    for r in conn.execute("SELECT * FROM boards ORDER BY updated_at DESC"):
        data = json.loads(r["data"])
        out.append({"id": r["id"], "name": r["name"], "updated_at": r["updated_at"],
                    "count": len(data.get("items", [])), "preview": _board_preview(data, known)})
    return out


@app.post("/api/boards")
def create_board(b: BoardIn):
    now = time.time()
    data = json.dumps(b.data or {"items": []}, ensure_ascii=False)
    bid = db.connect().execute("INSERT INTO boards(name, data, created_at, updated_at) VALUES (?,?,?,?)",
                               ((b.name or tr("Новая доска")).strip(), data, now, now)).lastrowid
    return {"id": bid}


@app.get("/api/boards/{bid}")
def get_board(bid: int):
    r = db.connect().execute("SELECT * FROM boards WHERE id = ?", (bid,)).fetchone()
    if not r:
        raise HTTPException(404, tr("Доска не найдена"))
    return {"id": r["id"], "name": r["name"], "data": json.loads(r["data"]), "updated_at": r["updated_at"]}


@app.put("/api/boards/{bid}")
def save_board(bid: int, b: BoardIn):
    conn = db.connect()
    if b.name is not None:
        conn.execute("UPDATE boards SET name = ?, updated_at = ? WHERE id = ?", (b.name.strip() or tr("Доска"), time.time(), bid))
    if b.data is not None:
        conn.execute("UPDATE boards SET data = ?, updated_at = ? WHERE id = ?",
                     (json.dumps(b.data, ensure_ascii=False), time.time(), bid))
    return {"ok": True}


@app.delete("/api/boards/{bid}")
def delete_board(bid: int):
    db.connect().execute("DELETE FROM boards WHERE id = ?", (bid,))
    return {"ok": True}


def _pictures_dir() -> Path:
    home = Path.home()
    for name in ("Pictures", "Изображения"):
        if (home / name).is_dir():
            return home / name / "Refis"
    return db.DATA_DIR / "exports"


@app.post("/api/boards/{bid}/export")
def export_board(bid: int, file: UploadFile = File(...)):
    out_dir = _pictures_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    base = _safe_name(os.path.splitext(file.filename or tr("доска"))[0]) or tr("доска")
    target, n = out_dir / f"{base}.png", 1
    while target.exists():
        target = out_dir / f"{base} ({n}).png"; n += 1
    with open(target, "wb") as out:
        while chunk := file.file.read(1 << 20):
            out.write(chunk)
    return {"path": str(target)}


@app.post("/api/boards/{bid}/reveal-export")
def reveal_export(bid: int, path: str):
    p = Path(path).resolve()
    if p.parent != _pictures_dir().resolve() or not p.exists():
        raise HTTPException(400)
    _reveal(str(p))
    return {"ok": True}


_ASSET_RE = re.compile(r"^[0-9a-f]{32}\.(png|jpe?g|gif|webp|bmp)$")


@app.post("/api/board-assets")
def upload_asset(file: UploadFile = File(...)):
    """Картинки, вставленные на доску из буфера обмена или перетащенные из браузера."""
    ext = os.path.splitext(file.filename or "")[1].lower().lstrip(".") or "png"
    if ext not in ("png", "jpg", "jpeg", "gif", "webp", "bmp"):
        ext = "png"
    name = f"{uuid.uuid4().hex}.{ext}"
    with open(db.ASSET_DIR / name, "wb") as out:
        while chunk := file.file.read(1 << 20):
            out.write(chunk)
    return {"src": f"/api/board-assets/{name}"}


@app.get("/api/board-assets/{name}")
def get_asset(name: str):
    if not _ASSET_RE.match(name) or not (db.ASSET_DIR / name).exists():
        raise HTTPException(404)
    return FileResponse(db.ASSET_DIR / name, headers={"Cache-Control": "max-age=31536000, immutable"})


app.include_router(organize.router)
app.include_router(system.router)
app.include_router(profile.router)
app.include_router(pinterest.router)
app.include_router(packs.router)
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
