"""Настройки, проверка обновлений, резервные копии и служебные действия."""
import datetime as dt
import json
import logging
import platform
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import webbrowser
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from . import GITHUB_REPO, TELEGRAM_URL, __version__, db, i18n
from .i18n import tr
from .net import http_get

log = logging.getLogger("refis")
router = APIRouter(prefix="/api")

# ======================================================================= настройки

DEFAULTS = {
    "name": "",               # как обращаться в приветствии
    "theme": "dark",          # dark | light | system
    "lang": "ru",             # ru | en
    "motion": "full",         # full | reduced
    "ambient": True,          # цветной фон
    "start_page": "today",    # today | library | organize | boards | last
    "check_updates": True,
    "auto_backup": True,
    "pinterest_sync": True,
    "pinterest_feed": True,   # собирать пины из ленты рекомендаций в окне Pinterest
}


def get_all() -> dict:
    out = dict(DEFAULTS)
    for r in db.connect().execute("SELECT key, value FROM settings"):
        if r["key"] in DEFAULTS:
            try:
                out[r["key"]] = json.loads(r["value"])
            except ValueError:
                pass
    return out


def get(key: str):
    return get_all()[key]


def set_many(values: dict) -> dict:
    conn = db.connect()
    for k, v in values.items():
        if k not in DEFAULTS:
            raise HTTPException(400, tr("Неизвестная настройка: {k}", k=k))
        if type(v) is not type(DEFAULTS[k]):
            raise HTTPException(400, tr("Неверное значение для {k}", k=k))
        conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (k, json.dumps(v)))
    i18n.reset()
    return get_all()


@router.get("/settings")
def settings_get():
    return get_all()


@router.patch("/settings")
def settings_patch(values: dict):
    return set_many(values)


# ======================================================================= о программе

@router.get("/about")
def about():
    return {
        "version": __version__, "repo": GITHUB_REPO, "telegram": TELEGRAM_URL,
        "data_dir": str(db.DATA_DIR), "python": platform.python_version(),
        "os": f"{platform.system()} {platform.release()}", "frozen": bool(getattr(sys, "frozen", False)),
    }


class UrlIn(BaseModel):
    url: str


@router.post("/open-url")
def open_url(u: UrlIn):
    """Открывает ссылку в браузере по умолчанию (из окна приложения window.open не всегда срабатывает)."""
    if not re.match(r"https?://", u.url):
        raise HTTPException(400, tr("Можно открывать только веб-ссылки"))
    webbrowser.open(u.url)
    return {"ok": True}


@router.post("/open-data-dir")
def open_data_dir():
    from .server import _reveal
    _reveal(str(db.DATA_DIR / "refis.db"))
    return {"ok": True}


@router.get("/report-url")
def report_url():
    """Ссылка на новую задачу в GitHub с версией и системой (без путей и личных данных)."""
    body = (f"**Что случилось:**\n\n\n**Как повторить:**\n1. \n\n"
            f"---\nRefis {__version__} · {platform.system()} {platform.release()} · "
            f"{'exe' if getattr(sys, 'frozen', False) else 'python ' + platform.python_version()}\n"
            "Если можно — приложите файл refis.log из папки данных (Настройки → Открыть папку данных).")
    return {"url": f"https://github.com/{GITHUB_REPO}/issues/new?body={quote(body)}"}


# ======================================================================= обновления

_update_cache: dict = {"at": 0, "data": None}


def _ver(v: str) -> tuple:
    nums = re.findall(r"\d+", v)
    return tuple(int(x) for x in nums[:3]) + (0,) * (3 - len(nums[:3]))


def check_updates(force: bool = False) -> dict:
    if not force and _update_cache["data"] and time.time() - _update_cache["at"] < 6 * 3600:
        return _update_cache["data"]
    out = {"current": __version__, "latest": None, "newer": False, "url": f"https://github.com/{GITHUB_REPO}/releases"}
    try:
        data, _, _ = http_get(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest", timeout=10,
                              headers={"Accept": "application/vnd.github+json"})
        rel = json.loads(data)
        latest = rel.get("tag_name", "").lstrip("v")
        setup = next((a["browser_download_url"] for a in rel.get("assets", []) if a["name"].lower().endswith("setup-" + latest + ".exe")
                      or (a["name"].lower().endswith(".exe") and "setup" in a["name"].lower())), None)
        out.update(latest=latest, newer=_ver(latest) > _ver(__version__), url=rel.get("html_url", out["url"]),
                   download=setup, notes=(rel.get("body") or "")[:3000], published=rel.get("published_at"))
    except Exception as e:  # нет сети, приватный репозиторий или ещё нет релизов
        out["error"] = str(e)[:200]
    _update_cache.update(at=time.time(), data=out)
    return out


@router.get("/update")
def update(force: bool = False):
    return check_updates(force)


# ======================================================================= резервные копии

BACKUP_DIR = db.DATA_DIR / "backups"
KEEP_AUTO = 7


def _snapshot_db(target: Path) -> None:
    """Целостная копия базы, даже пока приложение пишет в неё."""
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(target)
    with dst:
        src.backup(dst)
    src.close()
    dst.close()


def make_backup(dest_dir: Path, prefix: str = "Refis-backup") -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = f"{prefix}-{dt.datetime.now():%Y-%m-%d_%H%M%S}.zip"
    out = dest_dir / name
    with tempfile.TemporaryDirectory() as tmp:
        snap = Path(tmp) / "refis.db"
        _snapshot_db(snap)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(snap, "refis.db")
            z.writestr("refis-backup.json", json.dumps({"version": __version__, "created": time.time()}))
            for f in db.ASSET_DIR.glob("*"):  # картинки, вставленные на доски
                z.write(f, f"board_assets/{f.name}")
    return out


def auto_backup() -> None:
    """Раз в сутки при запуске — тихая копия в папку данных, хранятся последние 7."""
    try:
        if not get("auto_backup") or not db.DB_PATH.exists():
            return
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        autos = sorted(BACKUP_DIR.glob("auto-*.zip"))
        if autos and time.time() - autos[-1].stat().st_mtime < 20 * 3600:
            return
        make_backup(BACKUP_DIR, "auto")
        for old in sorted(BACKUP_DIR.glob("auto-*.zip"))[:-KEEP_AUTO]:
            old.unlink(missing_ok=True)
    except Exception as e:
        log.warning("автокопия не создана: %s", e)


def documents_dir() -> Path:
    home = Path.home()
    for n in ("Documents", "Документы"):
        if (home / n).is_dir():
            return home / n / "Refis"
    return BACKUP_DIR


@router.get("/backups")
def backups():
    out = []
    for folder in {BACKUP_DIR, documents_dir()}:
        for f in folder.glob("*.zip"):
            out.append({"name": f.name, "path": str(f), "size": f.stat().st_size, "time": f.stat().st_mtime,
                        "auto": f.name.startswith("auto-")})
    return sorted(out, key=lambda b: -b["time"])


@router.post("/backup")
def backup_now():
    path = make_backup(documents_dir())
    return {"path": str(path), "size": path.stat().st_size}


class PathIn(BaseModel):
    path: str


@router.post("/backup/reveal")
def backup_reveal(p: PathIn):
    path = Path(p.path).resolve()
    if path.suffix != ".zip" or path.parent not in (BACKUP_DIR.resolve(), documents_dir().resolve()) or not path.exists():
        raise HTTPException(400)
    from .server import _reveal
    _reveal(str(path))
    return {"ok": True}


PENDING = db.DATA_DIR / "restore-pending"


def _validate_backup(zpath: Path) -> None:
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        if "refis.db" not in names:
            raise HTTPException(400, tr("Это не резервная копия Refis (нет refis.db)"))
        with z.open("refis.db") as f:
            if f.read(16) != b"SQLite format 3\x00":
                raise HTTPException(400, tr("Файл базы в копии повреждён"))
        for n in names:
            if n.startswith("/") or ".." in Path(n).parts:
                raise HTTPException(400, tr("Недопустимые пути в архиве"))


def _stage_restore(zpath: Path) -> None:
    _validate_backup(zpath)
    shutil.rmtree(PENDING, ignore_errors=True)
    PENDING.mkdir(parents=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(PENDING)


@router.post("/restore")
def restore(file: UploadFile = File(...)):
    """Восстановление применяется при следующем запуске — пока приложение работает, базу не трогаем."""
    tmp = db.DATA_DIR / "restore-upload.zip"
    with open(tmp, "wb") as out:
        while chunk := file.file.read(1 << 20):
            out.write(chunk)
    try:
        _stage_restore(tmp)
    except zipfile.BadZipFile:
        raise HTTPException(400, tr("Файл не является zip-архивом"))
    finally:
        tmp.unlink(missing_ok=True)
    return {"restart": True}


@router.post("/restore/from")
def restore_from(p: PathIn):
    path = Path(p.path).resolve()
    if path.parent not in (BACKUP_DIR.resolve(), documents_dir().resolve()) or not path.exists():
        raise HTTPException(400)
    _stage_restore(path)
    return {"restart": True}


def apply_pending_restore() -> bool:
    """Вызывается при старте до открытия базы. Текущая база сохраняется рядом на всякий случай."""
    if not (PENDING / "refis.db").exists():
        return False
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = f"{dt.datetime.now():%Y-%m-%d_%H%M%S}"
    if db.DB_PATH.exists():
        with zipfile.ZipFile(BACKUP_DIR / f"before-restore-{stamp}.zip", "w", zipfile.ZIP_DEFLATED) as z:
            z.write(db.DB_PATH, "refis.db")
    for suffix in ("", "-wal", "-shm"):
        Path(str(db.DB_PATH) + suffix).unlink(missing_ok=True)
    shutil.move(str(PENDING / "refis.db"), db.DB_PATH)
    if (PENDING / "board_assets").is_dir():
        for f in (PENDING / "board_assets").iterdir():
            shutil.copy2(f, db.ASSET_DIR / f.name)
    shutil.rmtree(db.THUMB_DIR, ignore_errors=True)  # превью пересоздадутся под новую базу
    db.THUMB_DIR.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(PENDING, ignore_errors=True)
    log.info("база восстановлена из резервной копии")
    return True


def startup() -> None:
    threading.Thread(target=auto_backup, daemon=True).start()
