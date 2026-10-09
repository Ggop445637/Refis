"""Pinterest: подключение публичных досок и профиля через их RSS-ленты.

Официальный API Pinterest требует регистрации приложения разработчика, поэтому Refis
использует открытые RSS-ленты: https://www.pinterest.com/<user>/feed.rss (последние пины профиля)
и https://www.pinterest.com/<user>/<board>.rss (пины доски). Работает только с публичными досками.
"""
import email.utils
import html
import logging
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import db, media
from .net import http_get

log = logging.getLogger("refis")
router = APIRouter(prefix="/api/pinterest")
SYNC_EVERY = 3 * 3600
_RESERVED = {"pin", "search", "ideas", "today", "settings", "business", "_", "explore", "categories"}
_lock = threading.Lock()


# ======================================================================= ссылки

def parse_source(text: str) -> dict:
    """Ссылка на профиль/доску или имя пользователя → RSS-лента."""
    text = text.strip().strip("<>\"'")
    if not text:
        raise ValueError("Пустая ссылка")
    if "pin.it/" in text:  # короткая ссылка из приложения — раскрываем
        _, _, final = http_get(text if text.startswith("http") else "https://" + text)
        text = final
    if not re.match(r"https?://", text):
        if "pinterest." in text:
            text = "https://" + text
        else:  # просто имя пользователя
            user = text.lstrip("@").strip("/")
            if not re.fullmatch(r"[A-Za-z0-9_.\-]{2,40}", user):
                raise ValueError("Не похоже на ссылку Pinterest или имя пользователя")
            return _source(user, None)
    u = urlparse(text)
    if "pinterest." not in u.netloc:
        raise ValueError("Это не ссылка на Pinterest")
    parts = [p for p in u.path.split("/") if p]
    if parts and parts[-1].endswith(".rss"):
        parts[-1] = parts[-1][:-4]
        if parts[-1] == "feed":
            parts = parts[:-1]
    if not parts or parts[0] in _RESERVED:
        raise ValueError("Нужна ссылка на профиль или доску, например pinterest.com/имя/доска")
    return _source(parts[0], parts[1] if len(parts) > 1 else None)


def _source(user: str, board: str | None) -> dict:
    if board:
        return {"kind": "board", "url": f"https://www.pinterest.com/{user}/{board}.rss",
                "page": f"https://www.pinterest.com/{user}/{board}/",
                "title": board.replace("-", " ").strip(), "tag": db.normalize_tag(board.replace("-", " "))}
    return {"kind": "user", "url": f"https://www.pinterest.com/{user}/feed.rss",
            "page": f"https://www.pinterest.com/{user}/", "title": f"Профиль {user}", "tag": ""}


# ======================================================================= лента

_IMG = re.compile(r"""<img[^>]+src=["']([^"']+)["']""", re.I)


def parse_feed(data: bytes) -> tuple[str, list[dict]]:
    root = ET.fromstring(data)
    ch = root.find("channel")
    if ch is None:
        raise ValueError("Pinterest вернул не RSS-ленту (доска приватная или ссылка неверна)")
    title = html.unescape((ch.findtext("title") or "").strip())
    items = []
    for it in ch.findall("item"):
        desc = it.findtext("description") or ""
        m = _IMG.search(desc)
        img = m.group(1) if m else ""
        if not img:
            enc = it.find("enclosure")
            img = enc.get("url", "") if enc is not None else ""
        if not img:
            continue
        link = (it.findtext("link") or "").strip()
        guid = (it.findtext("guid") or link or img).strip()
        text = html.unescape(re.sub(r"<[^>]+>", " ", desc))
        name = html.unescape((it.findtext("title") or "").strip()) or " ".join(text.split())[:80]
        pub = None
        if it.findtext("pubDate"):
            try:
                pub = email.utils.parsedate_to_datetime(it.findtext("pubDate")).timestamp()
            except (TypeError, ValueError):
                pass
        items.append({"guid": guid, "title": name[:200], "link": link, "image": img, "published": pub})
    return title, items


def image_candidates(url: str) -> list[str]:
    """Сначала оригинал, потом 736px, потом то, что было в ленте."""
    out = []
    if re.search(r"/\d+x(\d+)?/", url):
        out.append(re.sub(r"/\d+x(\d+)?/", "/originals/", url, count=1))
        out.append(re.sub(r"/\d+x(\d+)?/", "/736x/", url, count=1))
    out.append(url)
    return list(dict.fromkeys(out))


def sync_source(sid: int) -> dict:
    conn = db.connect()
    s = conn.execute("SELECT * FROM pin_sources WHERE id = ?", (sid,)).fetchone()
    if not s:
        return {"added": 0}
    try:
        data, _, _ = http_get(s["url"])
        title, items = parse_feed(data)
    except Exception as e:
        msg = str(e) if isinstance(e, ValueError) else f"Не удалось загрузить ленту: {e}"
        conn.execute("UPDATE pin_sources SET last_error = ?, last_sync = ? WHERE id = ?", (msg, time.time(), sid))
        log.warning("pinterest %s: %s", s["url"], e)
        return {"added": 0, "error": msg}
    added = []
    for it in items:
        cur = conn.execute(
            "INSERT OR IGNORE INTO pins(guid, source_id, title, link, image, published, added_at) VALUES (?,?,?,?,?,?,?)",
            (it["guid"], sid, it["title"], it["link"], it["image"], it["published"], time.time()))
        if cur.rowcount:
            added.append(cur.lastrowid)
    # название из ленты заменяет «черновое» (из адреса), но не то, что задал пользователь
    parts = [x for x in urlparse(s["page"]).path.split("/") if x]
    default = _source(parts[0], parts[1] if len(parts) > 1 else None)["title"] if parts else ""
    upd_title = title if title and s["title"] in ("", default) else s["title"]
    conn.execute("UPDATE pin_sources SET last_sync = ?, last_error = '', title = ? WHERE id = ?", (time.time(), upd_title, sid))
    if s["auto_save"] and s["folder_id"] and added:
        save_pins(added, s["folder_id"], None, None)
    return {"added": len(added)}


def sync_all(force: bool = False) -> None:
    if not _lock.acquire(blocking=False):
        return
    try:
        conn = db.connect()
        for s in conn.execute("SELECT id, last_sync FROM pin_sources").fetchall():
            if force or not s["last_sync"] or time.time() - s["last_sync"] > SYNC_EVERY:
                sync_source(s["id"])
    finally:
        _lock.release()


def background_sync() -> None:
    def loop():
        time.sleep(20)
        from . import system
        while True:
            try:
                if system.get("pinterest_sync"):
                    sync_all()
            except Exception as e:
                log.warning("pinterest sync: %s", e)
            time.sleep(1800)
    threading.Thread(target=loop, daemon=True, name="pinterest").start()


# ======================================================================= скачивание

_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}


def download_image(url: str) -> tuple[bytes, str]:
    last = None
    for cand in image_candidates(url):
        try:
            data, ctype, _ = http_get(cand)
            ext = _EXT.get(ctype.split(";")[0].strip()) or os.path.splitext(urlparse(cand).path)[1] or ".jpg"
            if data and ctype.startswith("image/"):
                return data, ext
        except Exception as e:
            last = e
    raise RuntimeError(f"Не удалось скачать картинку: {last}")


def save_pins(ids: list[int], folder_id: int, subdir: str | None, tags: list[str] | None) -> list[dict]:
    conn = db.connect()
    folder = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if not folder:
        raise ValueError("Папка не найдена")
    out = []
    for pid in ids:
        p = conn.execute("SELECT p.*, s.title board, s.tag stag FROM pins p JOIN pin_sources s ON s.id = p.source_id"
                         " WHERE p.id = ?", (pid,)).fetchone()
        if not p or p["status"] == "saved":
            continue
        try:
            cached = db.PIN_DIR / f"{pid}.full"
            if cached.exists():
                data, ext = cached.read_bytes(), (cached.with_suffix(".ext").read_text() if cached.with_suffix(".ext").exists() else ".jpg")
            else:
                data, ext = download_image(p["image"])
            dest = media.target_dir(folder["path"], subdir if subdir is not None else f"Pinterest/{p['board'] or 'Pinterest'}")
            base = media.safe_name(p["title"][:60]) if p["title"] else f"pin_{pid}"
            path = media.unique_path(dest, base + ext)
            with open(path, "wb") as f:
                f.write(data)
            tag_list = list(tags) if tags is not None else [t for t in (p["stag"], "pinterest") if t]
            # пины — всегда чужие референсы, даже если папка «мои работы»
            mid = media.register_file(conn, folder, path, "ref", tag_list, source=p["link"] or "pinterest")
            if p["title"]:
                conn.execute("UPDATE media SET notes = ? WHERE id = ?", (p["title"], mid))
            conn.execute("UPDATE pins SET status = 'saved', media_id = ? WHERE id = ?", (mid, pid))
            out.append({"pin": pid, "media": mid})
        except Exception as e:
            log.warning("pin %s: %s", pid, e)
            out.append({"pin": pid, "error": str(e)})
    media.thumbs.kick()
    return out


# ======================================================================= API

class SourceIn(BaseModel):
    url: str
    tag: str | None = None
    folder_id: int | None = None
    auto_save: bool = False


class SourcePatch(BaseModel):
    title: str | None = None
    tag: str | None = None
    folder_id: int | None = None
    auto_save: bool | None = None


@router.get("/sources")
def sources():
    return [dict(r) for r in db.connect().execute(
        "SELECT s.*, (SELECT COUNT(*) FROM pins p WHERE p.source_id = s.id AND p.status = 'new') new,"
        " (SELECT COUNT(*) FROM pins p WHERE p.source_id = s.id) total FROM pin_sources s ORDER BY s.kind DESC, s.title")]


@router.post("/sources")
def add_source(s: SourceIn):
    try:
        src = parse_source(s.url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Не удалось открыть ссылку: {e}")
    conn = db.connect()
    if conn.execute("SELECT 1 FROM pin_sources WHERE url = ?", (src["url"],)).fetchone():
        raise HTTPException(400, "Эта доска уже подключена")
    sid = conn.execute(
        "INSERT INTO pin_sources(url, page, kind, title, tag, folder_id, auto_save) VALUES (?,?,?,?,?,?,?)",
        (src["url"], src["page"], src["kind"], src["title"], db.normalize_tag(s.tag) if s.tag else src["tag"],
         s.folder_id, int(s.auto_save))).lastrowid
    res = sync_source(sid)
    return {"id": sid, **res}


@router.patch("/sources/{sid}")
def patch_source(sid: int, p: SourcePatch):
    conn = db.connect()
    f = p.model_dump(exclude_none=True)
    if "tag" in f:
        f["tag"] = db.normalize_tag(f["tag"])
    if "auto_save" in f:
        f["auto_save"] = int(f["auto_save"])
    if f:
        conn.execute(f"UPDATE pin_sources SET {', '.join(k + ' = ?' for k in f)} WHERE id = ?", [*f.values(), sid])
    return {"ok": True}


@router.delete("/sources/{sid}")
def delete_source(sid: int):
    conn = db.connect()
    for r in conn.execute("SELECT id FROM pins WHERE source_id = ?", (sid,)):
        for suffix in (".jpg", ".full", ".ext"):
            (db.PIN_DIR / f"{r['id']}{suffix}").unlink(missing_ok=True)
    conn.execute("DELETE FROM pins WHERE source_id = ?", (sid,))
    conn.execute("DELETE FROM pin_sources WHERE id = ?", (sid,))
    return {"ok": True}


@router.post("/sources/{sid}/sync")
def sync_one(sid: int):
    return sync_source(sid)


@router.post("/sync")
def sync_everything():
    threading.Thread(target=sync_all, args=(True,), daemon=True).start()
    return {"ok": True}


@router.get("/pins")
def pins(status: str = "new", source: int = 0, limit: int = 200, offset: int = 0):
    q = ("SELECT p.id, p.title, p.link, p.status, p.media_id, p.published, s.title board, s.id source_id"
         " FROM pins p JOIN pin_sources s ON s.id = p.source_id WHERE p.status = ?")
    args: list = [status]
    if source:
        q += " AND p.source_id = ?"
        args.append(source)
    conn = db.connect()
    total = conn.execute(f"SELECT COUNT(*) FROM ({q})", args).fetchone()[0]
    rows = conn.execute(q + " ORDER BY COALESCE(p.published, p.added_at) DESC LIMIT ? OFFSET ?", args + [limit, offset])
    return {"total": total, "items": [dict(r) for r in rows]}


class PinsSave(BaseModel):
    ids: list[int]
    folder_id: int
    subdir: str | None = None
    tags: list[str] | None = None


@router.post("/pins/save")
def pins_save(b: PinsSave):
    try:
        res = save_pins(b.ids, b.folder_id, b.subdir, b.tags)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"results": res, "saved": [r["media"] for r in res if "media" in r],
            "errors": [r for r in res if "error" in r]}


class PinsStatus(BaseModel):
    ids: list[int]
    status: str


@router.post("/pins/status")
def pins_status(b: PinsStatus):
    if b.status not in ("new", "hidden"):
        raise HTTPException(400)
    db.connect().executemany("UPDATE pins SET status = ? WHERE id = ? AND status != 'saved'", [(b.status, i) for i in b.ids])
    return {"ok": True}


@router.get("/pins/{pid}/img")
def pin_image(pid: int, full: bool = False):
    """Превью (или полная картинка) пина с кэшем на диске — потом работает и без интернета."""
    small = db.PIN_DIR / f"{pid}.jpg"
    big = db.PIN_DIR / f"{pid}.full"
    target = big if full else small
    if not target.exists():
        r = db.connect().execute("SELECT image FROM pins WHERE id = ?", (pid,)).fetchone()
        if not r:
            raise HTTPException(404)
        try:
            if full:
                data, ext = download_image(r["image"])
                big.write_bytes(data)
                big.with_suffix(".ext").write_text(ext)
            else:
                url = image_candidates(r["image"])[1 if len(image_candidates(r["image"])) > 2 else -1]
                try:
                    data, _, _ = http_get(url)
                except Exception:
                    data, _, _ = http_get(r["image"])
                small.write_bytes(data)
        except Exception as e:
            raise HTTPException(502, f"Нет связи с Pinterest: {e}")
    if full:
        ext = big.with_suffix(".ext").read_text() if big.with_suffix(".ext").exists() else ".jpg"
        mt = {".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}.get(ext, "image/jpeg")
        return FileResponse(big, media_type=mt, headers={"Cache-Control": "max-age=86400"})
    return FileResponse(small, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
