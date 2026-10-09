"""Наборы референсов: подборка или доска в одном файле .refis, которым можно поделиться.

Файл — обычный zip:
  refis-pack.json   описание: название, автор, файлы с тегами и заметками, доска (если есть)
  files/…           сами картинки и видео
  assets/…          картинки, вставленные прямо на доску
"""
import io
import json
import os
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageOps
from pydantic import BaseModel

from . import __version__, db, folders, media
from .i18n import tr

router = APIRouter(prefix="/api/packs")

MANIFEST = "refis-pack.json"
FORMAT = 1
EXT = ".refis"
INBOX = db.DATA_DIR / "pack-inbox"
_TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
_ASSET_SRC = re.compile(r"^/api/board-assets/([0-9a-f]{32}\.(?:png|jpe?g|gif|webp|bmp))$")
_PACKED = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".jfif"} | media.VIDEO_EXT  # уже сжаты — не тратим время


def packs_dir() -> Path:
    from .system import documents_dir
    return documents_dir() / tr("Наборы")


# ======================================================================= экспорт

class ExportIn(BaseModel):
    name: str
    author: str = ""
    description: str = ""
    ids: list[int] = []
    board_id: int | None = None
    tag: str = ""      # все файлы с тегом
    folder_id: int | None = None  # целая папка библиотеки (или её подпапка sub) со всей структурой
    sub: str = ""
    kind: str = ""     # целый раздел: «Референсы», «Мои работы» или свой
    notes: bool = True  # заметки бывают личными — можно не включать


def _board(bid: int | None) -> dict | None:
    if not bid:
        return None
    r = db.connect().execute("SELECT name, data FROM boards WHERE id = ?", (bid,)).fetchone()
    if not r:
        raise HTTPException(404, tr("Доска не найдена"))
    return {"name": r["name"], "data": json.loads(r["data"])}


def _folder(fid: int | None, sub: str):
    """(папка, корень экспорта на диске) или None."""
    if not fid:
        return None
    f = folders.get_folder(db.connect(), fid)
    return f, folders.sub_path(f, sub)


def _collect(ids: list[int], board: dict | None, tag: str = "", folder=None, sub: str = "", kind: str = "") -> list:
    """Файлы набора по порядку, без повторов и без пропавших с диска."""
    conn = db.connect()
    by_kind = [r[0] for r in conn.execute(
        "SELECT id FROM media WHERE kind = ? AND missing = 0 ORDER BY folder_id, path", (kind,))] if kind else []
    by_folder = []
    if folder:
        c, a = folders.under_clause(folder[0], sub)
        by_folder = [r[0] for r in conn.execute(f"SELECT m.id FROM media m WHERE {c} ORDER BY m.path", a)]
    by_tag = [r[0] for r in conn.execute(
        "SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id"
        " WHERE t.name = ? ORDER BY m.added_at", (db.normalize_tag(tag),))] if tag.strip() else []
    order = list(dict.fromkeys(
        [i["mid"] for i in (board or {}).get("data", {}).get("items", []) if i.get("type") == "media" and i.get("mid")]
        + ids + by_tag + by_folder + by_kind))
    rows = {}
    for k in range(0, len(order), 900):
        part = order[k:k + 900]
        rows.update((r["id"], r) for r in conn.execute(f"SELECT * FROM media WHERE id IN ({','.join('?' * len(part))})", part))
    return [rows[i] for i in order if i in rows and not rows[i]["missing"] and os.path.exists(rows[i]["path"])]


class EstimateIn(BaseModel):
    ids: list[int] = []
    board_id: int | None = None
    tag: str = ""
    folder_id: int | None = None
    sub: str = ""
    kind: str = ""


@router.post("/estimate")
def estimate(b: EstimateIn):
    rows = _collect(b.ids, _board(b.board_id), b.tag, _folder(b.folder_id, b.sub), b.sub, b.kind)
    return {"count": len(rows), "size": sum(r["size"] for r in rows),
            "videos": sum(r["type"] == "video" for r in rows)}


def _tags_of(conn, mid: int) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT t.name FROM tags t JOIN media_tags mt ON mt.tag_id = t.id WHERE mt.media_id = ? ORDER BY t.name", (mid,))]


def _rel(path: str, root: str) -> str:
    rel = os.path.relpath(os.path.dirname(path), root).replace("\\", "/")
    return "" if rel == "." or rel.startswith("..") else folders.clean_sub(rel)


def _section_defs(conn, keys) -> list[dict]:
    rows = {r["key"]: r for r in conn.execute("SELECT * FROM sections")}
    return [{"key": k, "name": rows[k]["name"], "color": rows[k]["color"]} for k in dict.fromkeys(keys) if k in rows]


def build_pack(e: ExportIn, out: Path) -> dict:
    board = _board(e.board_id)
    folder = _folder(e.folder_id, e.sub)
    rows = _collect(e.ids, board, e.tag, folder, e.sub, e.kind)
    if not rows:
        raise HTTPException(400, tr("В наборе нет файлов"))
    conn = db.connect()
    lib_paths = {f["id"]: f["path"] for f in conn.execute("SELECT id, path FROM folders")}
    items, index, used = [], {}, set()
    for n, r in enumerate(rows):
        base = media.safe_name(os.path.basename(r["path"]))
        rel = ""
        if folder:  # структура подпапок сохраняется: «Руки/Мужские/…»
            rel = _rel(r["path"], folder[1])
        elif e.kind and r["folder_id"] in lib_paths:  # раздел: «папка библиотеки/подпапки/…»
            root = lib_paths[r["folder_id"]]
            rel = folders.clean_sub("/".join(x for x in (os.path.basename(root.rstrip("\\/")), _rel(r["path"], root)) if x))
        arc = f"files/{rel}/{base}" if rel else f"files/{base}"
        while arc.lower() in used:
            arc = f"files/{rel}/{n}_{base}" if rel else f"files/{n}_{base}"
        used.add(arc.lower())
        index[r["id"]] = len(items)
        items.append({"file": arc, "dir": rel, "name": r["name"], "type": r["type"], "kind": r["kind"],
                      "tags": _tags_of(conn, r["id"]), "source": r["source"], "notes": r["notes"] if e.notes else "",
                      "rating": r["rating"], "_path": r["path"]})
    pack_board, assets = None, []
    if board:
        b_items = []
        for it in board["data"].get("items", []):
            it = {k: v for k, v in it.items() if not k.startswith("_")}
            if it.get("type") == "media":
                if it.get("mid") not in index:
                    continue
                it["item"] = index[it.pop("mid")]
                it.pop("src", None)
            elif it.get("type") == "asset":
                m = _ASSET_SRC.match(it.get("src", ""))
                if not m or not (db.ASSET_DIR / m.group(1)).exists():
                    continue
                assets.append(m.group(1))
                it["src"] = f"assets/{m.group(1)}"
            b_items.append(it)
        pack_board = {"name": board["name"], "items": b_items, "view": board["data"].get("view")}
    manifest = {"format": FORMAT, "app": f"Refis {__version__}", "name": e.name.strip() or tr("Набор"),
                "author": e.author.strip(), "description": e.description.strip(), "created": time.time(),
                "items": [{k: v for k, v in i.items() if k != "_path"} for i in items], "board": pack_board,
                "folder": {"name": os.path.basename(folder[1].rstrip("\\/")), "kind": folder[0]["kind"]} if folder else None,
                "sections": _section_defs(conn, [i["kind"] for i in items] + ([e.kind] if e.kind else [])),
                "section": e.kind or None}
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=1))
            for i in items:
                packed = os.path.splitext(i["_path"])[1].lower() in _PACKED
                z.write(i["_path"], i["file"], zipfile.ZIP_STORED if packed else zipfile.ZIP_DEFLATED)
            for a in dict.fromkeys(assets):
                z.write(db.ASSET_DIR / a, f"assets/{a}", zipfile.ZIP_STORED)
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
    return {"path": str(out), "size": out.stat().st_size, "count": len(items)}


@router.post("/export")
def export(e: ExportIn):
    base = media.safe_name(e.name.strip() or tr("Набор"))
    out, n = packs_dir() / f"{base}{EXT}", 1
    while out.exists():
        out = packs_dir() / f"{base} ({n}){EXT}"; n += 1
    return build_pack(e, out)


class PathIn(BaseModel):
    path: str


@router.post("/reveal")
def reveal(p: PathIn):
    path = Path(p.path).resolve()
    if path.suffix != EXT or path.parent != packs_dir().resolve() or not path.exists():
        raise HTTPException(400)
    from .server import _reveal
    _reveal(str(path))
    return {"ok": True}


# ======================================================================= импорт

def read_manifest(z: zipfile.ZipFile) -> dict:
    try:
        m = json.loads(z.read(MANIFEST))
    except KeyError:
        raise HTTPException(400, tr("Это не набор Refis"))
    except ValueError:
        raise HTTPException(400, tr("Описание набора повреждено"))
    if not isinstance(m, dict) or not isinstance(m.get("items"), list):
        raise HTTPException(400, tr("Описание набора повреждено"))
    if m.get("format", 1) > FORMAT:
        raise HTTPException(400, tr("Набор создан в более новой версии Refis — обновите приложение"))
    names = set(z.namelist())
    # только файлы, которые действительно есть в архиве и похожи на картинку или видео
    m["items"] = [i for i in m["items"] if isinstance(i, dict) and i.get("file") in names and media.media_type(i["file"])]
    return m


def _inbox(token: str) -> Path:
    p = INBOX / f"{token}{EXT}"
    if not _TOKEN_RE.match(token) or not p.exists():
        raise HTTPException(404, tr("Набор не найден — откройте файл ещё раз"))
    return p


def clean_inbox(max_age: float = 86400) -> None:
    for f in INBOX.glob("*" + EXT):
        if time.time() - f.stat().st_mtime > max_age:
            f.unlink(missing_ok=True)


@router.post("/inspect")
def inspect(file: UploadFile = File(...)):
    INBOX.mkdir(parents=True, exist_ok=True)
    clean_inbox()
    token = uuid.uuid4().hex
    path = INBOX / f"{token}{EXT}"
    with open(path, "wb") as out:
        while chunk := file.file.read(1 << 20):
            out.write(chunk)
    try:
        with zipfile.ZipFile(path) as z:
            m = read_manifest(z)
            sizes = {i.filename: i.file_size for i in z.infolist()}
    except zipfile.BadZipFile:
        path.unlink(missing_ok=True)
        raise HTTPException(400, tr("Это не набор Refis"))
    except HTTPException:
        path.unlink(missing_ok=True)
        raise
    items = m["items"]
    tags: dict[str, int] = {}
    for i in items:
        for t in i.get("tags") or []:
            tags[t] = tags.get(t, 0) + 1
    if not items:
        path.unlink(missing_ok=True)
        raise HTTPException(400, tr("В наборе нет файлов"))
    return {
        "token": token, "name": str(m.get("name") or tr("Набор"))[:120], "author": str(m.get("author") or "")[:120],
        "description": str(m.get("description") or "")[:2000], "count": len(items),
        "videos": sum(media.media_type(i["file"]) == "video" for i in items),
        "size": sum(sizes.get(i["file"], 0) for i in items), "board": bool(m.get("board")),
        "tags": [t for t, _ in sorted(tags.items(), key=lambda x: -x[1])[:12]],
        "preview": [n for n, i in enumerate(items) if media.media_type(i["file"]) == "image"][:12],
        "folder": _manifest_folder(m), "dirs": len({_item_dir(i) for i in items} - {""}),
        "own": sum(i.get("kind") == "own" for i in items), "section": _manifest_section(m),
    }


def _defs(m: dict) -> dict:
    return {d["key"]: d for d in (m.get("sections") or []) if isinstance(d, dict) and isinstance(d.get("key"), str)}


_BUILTIN_NAMES = {"ref": "Референсы", "own": "Мои работы", "tutorial": "Туториалы", "other": "Прочее"}


def _section_name(d: dict) -> str:
    return str(d.get("name") or "").strip()[:60] or tr(_BUILTIN_NAMES.get(d.get("key"), "Раздел"))


def _manifest_section(m: dict) -> dict | None:
    key = m.get("section")
    if not isinstance(key, str):
        return None
    d = _defs(m).get(key, {"key": key})
    return {"name": _section_name(d), "color": d.get("color") or ""}


class SectionMap:
    """Разделы из набора → разделы этой библиотеки: тот же ключ, раздел с тем же именем или новый раздел."""

    def __init__(self, conn, m: dict):
        self.conn, self.defs, self.cache = conn, _defs(m), {}

    def __call__(self, key) -> str:
        if not isinstance(key, str) or not key:
            return "ref"
        if key not in self.cache:
            self.cache[key] = self._resolve(key)
        return self.cache[key]

    def _resolve(self, key: str) -> str:
        from . import sections
        local = db.kinds()
        d = self.defs.get(key)
        if key in db.BUILTIN_KINDS and key in local:
            return key
        if d is None:
            return key if key in local else "ref"
        row = self.conn.execute("SELECT name FROM sections WHERE key = ?", (key,)).fetchone()
        if row is not None and row["name"].strip().lower() == str(d.get("name") or "").strip().lower():
            return key  # набор сделан в этой же библиотеке
        name = _section_name(d)
        return sections.find_by_name(self.conn, name) or sections.create_section(self.conn, name, str(d.get("color") or ""))


def _manifest_folder(m: dict) -> dict | None:
    f = m.get("folder")
    if not isinstance(f, dict) or not isinstance(f.get("name"), str):
        return None
    # раздел папки, которого нет в этой библиотеке, создастся при импорте (пустой kind — «как в наборе»)
    return {"name": media.safe_name(f["name"])[:120], "kind": f.get("kind") if f.get("kind") in db.kinds() else ""}


def _item_dir(it: dict) -> str:
    return folders.clean_sub(it["dir"]) if isinstance(it.get("dir"), str) else ""


@router.get("/inbox/{token}/preview/{n}")
def preview(token: str, n: int):
    with zipfile.ZipFile(_inbox(token)) as z:
        items = read_manifest(z)["items"]
        if not 0 <= n < len(items):
            raise HTTPException(404)
        try:
            im = Image.open(io.BytesIO(z.read(items[n]["file"])))
            im.draft("RGB", (480, 480))
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((360, 360))
        except Exception:
            raise HTTPException(404)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    return Response(buf.getvalue(), media_type="image/jpeg")


class ImportIn(BaseModel):
    token: str
    folder_id: int | None = None  # в существующую папку библиотеки…
    new_parent: str = ""          # …или в новую: new_parent/new_name
    new_name: str = ""
    new_kind: str = "ref"         # пусто — раздел из набора
    subdir: str = ""
    tag: str = ""          # общий тег для всего набора, например «набор/анатомия»
    board: bool = True     # создать доску, если она есть в наборе
    own_as_ref: bool = True  # чужие «мои работы» становятся референсами; при переносе своей папки — нет


def _existing(conn, path: str) -> int | None:
    """Такой же файл уже есть в библиотеке — не кладём второй экземпляр."""
    size = os.path.getsize(path)
    qh = media.quick_hash(path, size)
    r = conn.execute("SELECT id FROM media WHERE qhash = ? AND size = ? AND missing = 0", (qh, size)).fetchone()
    return r["id"] if r else None


@router.post("/import")
def import_pack(b: ImportIn):
    src = _inbox(b.token)
    conn = db.connect()
    with zipfile.ZipFile(src) as z:
        m = read_manifest(z)
        smap = SectionMap(conn, m)
        name = str(m.get("name") or tr("Набор"))[:120]
        if b.folder_id:
            folder = conn.execute("SELECT * FROM folders WHERE id = ?", (b.folder_id,)).fetchone()
            if not folder:
                raise HTTPException(400, tr("Папка не найдена"))
            subdir = folders.clean_sub(b.subdir) if b.subdir.strip() else media.safe_name(name)
        else:
            new_kind = b.new_kind or smap(m.get("section") or (m.get("folder") or {}).get("kind") or "ref")
            if new_kind not in db.kinds():
                raise HTTPException(400, tr("Неизвестный тип"))
            path = folders.create_dir(b.new_parent, b.new_name or name)
            fid = folders.register_folder(conn, path, new_kind, scan=False)
            folder = conn.execute("SELECT * FROM folders WHERE id = ?", (fid,)).fetchone()
            subdir = folders.clean_sub(b.subdir)
        common = db.normalize_tag(b.tag)
        added, existing, ids = [], [], []
        for it in m["items"]:
            dest = media.target_dir(folder["path"], "/".join(x for x in (subdir, _item_dir(it)) if x))
            target = media.unique_path(dest, os.path.basename(it["file"]))
            with z.open(it["file"]) as f, open(target, "wb") as out:
                shutil.copyfileobj(f, out, 1 << 20)
            tags = [t for t in (it.get("tags") or []) if isinstance(t, str)] + ([common] if common else [])
            mid = _existing(conn, target)
            if mid:
                os.remove(target)
                existing.append(mid)
                for t in {db.normalize_tag(t) for t in tags} - {""}:
                    conn.execute("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", (mid, db.tag_id(conn, t)))
            else:
                kind = it.get("kind")
                if kind == "own" and b.own_as_ref:
                    kind = "ref"  # чужие работы для нас — референсы
                kind = smap(kind)
                mid = media.register_file(conn, folder, target, kind if kind in db.kinds() else "", tags,
                                          str(it.get("source") or "")[:500])
                if mid is None:
                    os.remove(target)
                    ids.append(None)
                    continue
                rating = it.get("rating") if isinstance(it.get("rating"), int) else 0
                conn.execute("UPDATE media SET notes = ?, rating = ? WHERE id = ?",
                             (str(it.get("notes") or "")[:5000], max(0, min(5, rating)), mid))
                added.append(mid)
            ids.append(mid)
        board_id = None
        if b.board and isinstance(m.get("board"), dict):
            board_id = _import_board(conn, z, m["board"], ids, name)
    src.unlink(missing_ok=True)
    media.thumbs.kick()
    return {"added": added, "existing": existing, "board_id": board_id, "name": name, "folder_id": folder["id"]}


def _import_board(conn, z: zipfile.ZipFile, board: dict, ids: list, name: str) -> int | None:
    names = set(z.namelist())
    items, assets = [], {}
    for it in board.get("items") or []:
        if not isinstance(it, dict):
            continue
        it = dict(it)
        if it.get("type") == "media":
            n = it.pop("item", None)
            if not isinstance(n, int) or not 0 <= n < len(ids) or ids[n] is None:
                continue
            row = conn.execute("SELECT id, type FROM media WHERE id = ?", (ids[n],)).fetchone()
            it.update(mid=row["id"], mtype=row["type"], src=f"/api/file/{row['id']}")
        elif it.get("type") == "asset":
            arc = it.get("src")
            m = re.match(r"^assets/[0-9a-f]{32}\.(png|jpe?g|gif|webp|bmp)$", str(arc))
            if not m or arc not in names:
                continue
            if arc not in assets:
                fname = f"{uuid.uuid4().hex}.{m.group(1)}"
                with z.open(arc) as f, open(db.ASSET_DIR / fname, "wb") as out:
                    shutil.copyfileobj(f, out)
                assets[arc] = f"/api/board-assets/{fname}"
            it["src"] = assets[arc]
        elif it.get("type") != "note":
            continue
        items.append(it)
    if not items:
        return None
    now = time.time()
    data = {"items": items, "view": board.get("view") if isinstance(board.get("view"), dict) else None}
    return conn.execute("INSERT INTO boards(name, data, created_at, updated_at) VALUES (?,?,?,?)",
                        (str(board.get("name") or name)[:120], json.dumps(data, ensure_ascii=False), now, now)).lastrowid
