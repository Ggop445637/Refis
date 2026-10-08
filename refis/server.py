"""HTTP API + раздача интерфейса."""
import json
import os
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

from . import db, media

STATIC = Path(__file__).resolve().parent / "static"

@asynccontextmanager
async def lifespan(_app):
    db.init()
    # пересканировать папки в фоне: подхватить новые/удалённые файлы
    threading.Thread(target=media.scan_all, daemon=True).start()
    media.thumbs.kick()
    yield


app = FastAPI(title="Refis", lifespan=lifespan)


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
        raise HTTPException(404, "Файл не найден в каталоге")
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
        raise HTTPException(400, f"Папка не найдена: {path}")
    if f.kind not in db.KINDS:
        raise HTTPException(400, "Неизвестный тип")
    conn = db.connect()
    for r in conn.execute("SELECT path FROM folders"):
        a, b = os.path.normcase(r["path"]), os.path.normcase(path)
        if a == b or b.startswith(a + os.sep) or a.startswith(b + os.sep):
            raise HTTPException(400, f"Пересекается с уже добавленной папкой: {r['path']}")
    fid = conn.execute("INSERT INTO folders(path, kind, auto_tags) VALUES (?,?,?)",
                       (path, f.kind, int(f.auto_tags))).lastrowid
    threading.Thread(target=media.scan_folder, args=(fid,), daemon=True).start()
    return {"id": fid, "path": path}


@app.patch("/api/folders/{fid}")
def patch_folder(fid: int, p: FolderPatch):
    conn = db.connect()
    if p.kind is not None:
        if p.kind not in db.KINDS:
            raise HTTPException(400, "Неизвестный тип")
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
        raise HTTPException(400, "Неизвестный тип")
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
            conn.executemany("DELETE FROM media WHERE id = ?", [(i,) for i in b.ids])
            for i in b.ids:
                media.thumb_path(i).unlink(missing_ok=True)
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
        raise HTTPException(404, "Файл не найден на диске")
    return FileResponse(r["path"])


def _path_of(mid: int) -> str:
    r = db.connect().execute("SELECT path FROM media WHERE id = ?", (mid,)).fetchone()
    if not r:
        raise HTTPException(404)
    return r["path"]


@app.post("/api/media/{mid}/reveal")
def reveal(mid: int):
    path = _path_of(mid)
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path)])
    return {"ok": True}


@app.post("/api/media/{mid}/open")
def open_external(mid: int):
    path = _path_of(mid)
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path])
    return {"ok": True}


# ---------------------------------------------------------------- upload (drag & drop)

def _safe_name(name: str) -> str:
    name = os.path.basename(name.replace("\\", "/"))
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "file"


@app.post("/api/upload")
def upload(files: list[UploadFile] = File(...), folder_id: int = Form(...), subdir: str = Form("_Входящие"),
           tags: str = Form(""), kind: str = Form("")):
    conn = db.connect()
    folder = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if not folder:
        raise HTTPException(400, "Папка не найдена")
    sub = [_safe_name(p) for p in re.split(r"[\\/]+", subdir) if p.strip(" .")]
    dest = os.path.join(folder["path"], *sub)
    os.makedirs(dest, exist_ok=True)
    tag_list = [t for t in (db.normalize_tag(x) for x in tags.split(",")) if t]
    added = []
    for f in files:
        name = _safe_name(f.filename or "file")
        mtype = media.media_type(name)
        if not mtype:
            continue
        base, ext = os.path.splitext(name)
        target, n = os.path.join(dest, name), 1
        while os.path.exists(target):
            target = os.path.join(dest, f"{base} ({n}){ext}"); n += 1
        with open(target, "wb") as out:
            while chunk := f.file.read(1 << 20):
                out.write(chunk)
        st = os.stat(target)
        mid = conn.execute(
            "INSERT INTO media(folder_id, path, name, ext, type, kind, size, mtime, qhash, added_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (folder_id, target, os.path.splitext(os.path.basename(target))[0], ext.lower().lstrip("."), mtype,
             kind if kind in db.KINDS else folder["kind"], st.st_size, st.st_mtime,
             media.quick_hash(target, st.st_size), time.time())).lastrowid
        for t in tag_list:
            conn.execute("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", (mid, db.tag_id(conn, t)))
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
        raise HTTPException(400, "Пустое имя")
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
                               (s.name.strip() or "Поиск", json.dumps(s.query, ensure_ascii=False))).lastrowid
    return {"id": sid}


@app.delete("/api/saved/{sid}")
def delete_saved(sid: int):
    db.connect().execute("DELETE FROM saved_searches WHERE id = ?", (sid,))
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
