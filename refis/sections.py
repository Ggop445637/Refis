"""Разделы библиотеки: «Референсы», «Мои работы»… и свои — создать, переименовать, перекрасить, удалить."""
import re
import secrets

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db
from .i18n import tr

router = APIRouter(prefix="/api/sections")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
PALETTE = ["#6aa8ff", "#ffb35c", "#5ee6a0", "#b48cff", "#ff6b8b", "#4fd1e0", "#f2d45c", "#a3e36b", "#ff8a5c", "#c0c4d0"]


def all_sections(conn) -> list[dict]:
    counts = dict(conn.execute("SELECT kind, COUNT(*) FROM media WHERE missing = 0 GROUP BY kind").fetchall())
    return [{"key": r["key"], "name": r["name"], "color": r["color"], "builtin": r["key"] in db.BUILTIN_KINDS,
             "deletable": r["key"] not in db.CORE_KINDS, "count": counts.get(r["key"], 0)}
            for r in conn.execute("SELECT * FROM sections ORDER BY pos, rowid")]


def find_by_name(conn, name: str) -> str | None:
    name = name.strip().lower()
    for s in all_sections(conn):
        if s["name"].strip().lower() == name:
            return s["key"]
    return None


def create_section(conn, name: str, color: str = "") -> str:
    name = " ".join(name.split())[:60]
    if not name:
        raise HTTPException(400, tr("Пустое имя"))
    if find_by_name(conn, name):
        raise HTTPException(400, tr("Раздел «{name}» уже есть", name=name))
    if not _COLOR.match(color or ""):
        used = {s["color"] for s in all_sections(conn)}
        color = next((c for c in PALETTE if c not in used), PALETTE[len(used) % len(PALETTE)])
    key = "s" + secrets.token_hex(4)
    pos = conn.execute("SELECT COALESCE(MAX(pos), 0) + 1 FROM sections").fetchone()[0]
    conn.execute("INSERT INTO sections(key, name, color, pos) VALUES (?,?,?,?)", (key, name, color, pos))
    return key


@router.get("")
def list_sections():
    return all_sections(db.connect())


class SectionIn(BaseModel):
    name: str
    color: str = ""


@router.post("")
def create(s: SectionIn):
    conn = db.connect()
    key = create_section(conn, s.name, s.color)
    return next(x for x in all_sections(conn) if x["key"] == key)


class SectionPatch(BaseModel):
    name: str | None = None   # пустая строка у встроенного — вернуть стандартное имя
    color: str | None = None


def _get(conn, key: str):
    r = conn.execute("SELECT * FROM sections WHERE key = ?", (key,)).fetchone()
    if not r:
        raise HTTPException(404, tr("Раздел не найден"))
    return r


@router.patch("/{key}")
def patch(key: str, p: SectionPatch):
    conn = db.connect()
    _get(conn, key)
    if p.name is not None:
        name = " ".join(p.name.split())[:60]
        if not name and key not in db.BUILTIN_KINDS:
            raise HTTPException(400, tr("Пустое имя"))
        other = find_by_name(conn, name) if name else None
        if other and other != key:
            raise HTTPException(400, tr("Раздел «{name}» уже есть", name=name))
        conn.execute("UPDATE sections SET name = ? WHERE key = ?", (name, key))
    if p.color is not None:
        if not _COLOR.match(p.color):
            raise HTTPException(400, tr("Неверный цвет"))
        conn.execute("UPDATE sections SET color = ? WHERE key = ?", (p.color, key))
    return next(x for x in all_sections(conn) if x["key"] == key)


class OrderIn(BaseModel):
    keys: list[str]


@router.put("/order")
def order(o: OrderIn):
    conn = db.connect()
    for i, k in enumerate(o.keys):
        conn.execute("UPDATE sections SET pos = ? WHERE key = ?", (i, k))
    return all_sections(conn)


class DeleteIn(BaseModel):
    move_to: str = "ref"   # куда перенести файлы раздела…
    trash: bool = False    # …или удалить их в Корзину


@router.post("/{key}/delete")
def delete(key: str, d: DeleteIn):
    conn = db.connect()
    _get(conn, key)
    if key in db.CORE_KINDS:
        raise HTTPException(400, tr("Этот раздел нужен приложению — его можно переименовать, но не удалить"))
    if d.move_to == key or d.move_to not in db.kinds():
        raise HTTPException(400, tr("Выберите другой раздел для файлов"))
    failed = []
    if d.trash:
        from .server import Ids, trash
        ids = [r[0] for r in conn.execute("SELECT id FROM media WHERE kind = ?", (key,))]
        failed = trash(Ids(ids=ids))["failed"] if ids else []
    # то, что не удалось удалить (или всё, если файлы переносим), уходит в другой раздел
    conn.execute("UPDATE media SET kind = ? WHERE kind = ?", (d.move_to, key))
    conn.execute("UPDATE folders SET kind = ? WHERE kind = ?", (d.move_to, key))
    conn.execute("DELETE FROM sections WHERE key = ?", (key,))
    return {"ok": True, "failed": failed}
