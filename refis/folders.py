"""Папки внутри приложения: дерево подпапок, создание папок, перемещение файлов между ними."""
import os
import re
import shutil
import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db, media
from .i18n import tr

router = APIRouter(prefix="/api")


def get_folder(conn, fid: int):
    f = conn.execute("SELECT * FROM folders WHERE id = ?", (fid,)).fetchone()
    if not f:
        raise HTTPException(404, tr("Папка не найдена"))
    return f


def clean_sub(sub: str) -> str:
    """«Руки/../Мужские» → «Руки/Мужские»: только имена внутри папки, без выхода наружу."""
    return "/".join(media.safe_name(p) for p in re.split(r"[\\/]+", sub or "") if p.strip(" ."))


def sub_path(folder, sub: str) -> str:
    sub = clean_sub(sub)
    return os.path.join(folder["path"], *sub.split("/")) if sub else folder["path"]


def under_clause(folder, sub: str) -> tuple[str, list]:
    """Условие SQL «файл лежит в этой подпапке или глубже»."""
    prefix = sub_path(folder, sub).rstrip("\\/") + os.sep
    return "m.folder_id = ? AND substr(m.path, 1, ?) = ?", [folder["id"], len(prefix), prefix]


# ======================================================================= дерево

@router.get("/folders/{fid}/tree")
def tree(fid: int):
    """Подпапки с числом файлов (вместе с вложенными). Пустые папки тоже видны — в них можно класть файлы."""
    conn = db.connect()
    f = get_folder(conn, fid)
    root = f["path"]
    counts: dict[str, int] = {}
    for (path,) in conn.execute("SELECT path FROM media WHERE folder_id = ? AND missing = 0", (fid,)):
        rel = os.path.relpath(os.path.dirname(path), root)
        if rel in (".", "") or rel.startswith(".."):
            continue
        parts = rel.replace("\\", "/").split("/")
        for i in range(1, len(parts) + 1):
            key = "/".join(parts[:i])
            counts[key] = counts.get(key, 0) + 1
    dirs = set(counts)
    for dirpath, dirnames, _ in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d.lower() not in media.SKIP_DIRS and not d.startswith("."))
        rel = os.path.relpath(dirpath, root).replace("\\", "/")
        for d in dirnames:
            dirs.add(d if rel == "." else f"{rel}/{d}")
        if len(dirs) > 3000:  # огромные деревья не показываем целиком
            break
    return [{"sub": d, "name": d.rsplit("/", 1)[-1], "depth": d.count("/"), "count": counts.get(d, 0)}
            for d in sorted(dirs, key=lambda x: [p.lower() for p in x.split("/")])]


class SubIn(BaseModel):
    sub: str = ""


@router.post("/folders/{fid}/reveal")
def reveal(fid: int, b: SubIn):
    from .server import _reveal
    path = sub_path(get_folder(db.connect(), fid), b.sub)
    if not os.path.isdir(path):
        raise HTTPException(404, tr("Папка не найдена"))
    _reveal(path)
    return {"ok": True}


# ======================================================================= создание

class MkdirIn(BaseModel):
    sub: str


@router.post("/folders/{fid}/mkdir")
def mkdir(fid: int, b: MkdirIn):
    f = get_folder(db.connect(), fid)
    sub = clean_sub(b.sub)
    if not sub:
        raise HTTPException(400, tr("Пустое имя"))
    media.target_dir(f["path"], sub)
    return {"sub": sub}


class CreateIn(BaseModel):
    parent: str
    name: str
    kind: str = "ref"


def default_parent() -> str:
    from .server import _pictures_dir
    return str(_pictures_dir())


@router.get("/folders/default-parent")
def get_default_parent():
    return {"path": default_parent()}


def register_folder(conn, path: str, kind: str, scan: bool = True) -> int:
    path = os.path.abspath(os.path.expanduser(path.strip().strip('"')))
    if not os.path.isdir(path):
        raise HTTPException(400, tr("Папка не найдена: {path}", path=path))
    if kind not in db.kinds():
        raise HTTPException(400, tr("Неизвестный тип"))
    for r in conn.execute("SELECT path FROM folders"):
        a, b = os.path.normcase(r["path"]), os.path.normcase(path)
        if a == b or b.startswith(a + os.sep) or a.startswith(b + os.sep):
            raise HTTPException(400, tr("Пересекается с уже добавленной папкой: {path}", path=r["path"]))
    fid = conn.execute("INSERT INTO folders(path, kind, auto_tags) VALUES (?,?,1)", (path, kind)).lastrowid
    if scan:
        threading.Thread(target=media.scan_folder, args=(fid,), daemon=True).start()
    return fid


def create_dir(parent: str, name: str) -> str:
    name = media.safe_name(re.sub(r"[\\/]+", "_", name.strip()))
    if not name.strip(" ."):
        raise HTTPException(400, tr("Пустое имя"))
    parent = os.path.abspath(os.path.expanduser(parent.strip().strip('"') or default_parent()))
    path = os.path.join(parent, name)
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as e:
        raise HTTPException(400, tr("Не удалось создать папку: {err}", err=e.strerror or str(e)))
    return path


@router.post("/folders/create")
def create(b: CreateIn):
    """Новая папка на диске, сразу подключённая к библиотеке."""
    path = create_dir(b.parent, b.name)
    fid = register_folder(db.connect(), path, b.kind)
    return {"id": fid, "path": path}


# ======================================================================= перемещение

class MoveIn(BaseModel):
    ids: list[int]
    folder_id: int
    sub: str = ""


@router.post("/media/move")
def move(b: MoveIn):
    """Перемещает файлы на диске в другую папку библиотеки; теги, оценки и заметки остаются."""
    conn = db.connect()
    f = get_folder(conn, b.folder_id)
    sub = clean_sub(b.sub)
    dest = media.target_dir(f["path"], sub)
    if not media._scan_lock.acquire(timeout=60):  # сканер не должен увидеть файл «пропавшим» посреди переноса
        raise HTTPException(409, tr("Идёт сканирование — попробуйте через минуту"))
    moved, failed = [], []
    try:
        for mid in dict.fromkeys(b.ids):
            r = conn.execute("SELECT id, path FROM media WHERE id = ?", (mid,)).fetchone()
            if not r:
                continue
            src = r["path"]
            if os.path.normcase(os.path.dirname(src)) == os.path.normcase(dest):
                continue
            try:
                target = media.unique_path(dest, os.path.basename(src))
                shutil.move(src, target)
            except OSError as e:
                failed.append({"id": mid, "name": os.path.basename(src), "error": (e.strerror or str(e))[:200]})
                continue
            conn.execute("UPDATE media SET path = ?, folder_id = ?, name = ?, missing = 0 WHERE id = ?",
                         (target, f["id"], os.path.splitext(os.path.basename(target))[0], mid))
            if f["auto_tags"]:
                for t in media.folder_tags(f["path"], target):
                    conn.execute("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", (mid, db.tag_id(conn, t)))
            moved.append(mid)
    finally:
        media._scan_lock.release()
    return {"ids": moved, "failed": failed}
