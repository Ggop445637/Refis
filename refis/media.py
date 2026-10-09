"""Сканирование папок и генерация превью (фото — Pillow, видео — ffmpeg)."""
import hashlib
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from PIL import Image, ImageOps

from . import db

log = logging.getLogger("refis")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".psd", ".jfif"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg"}
THUMB_SIZE = 480

# Папки, которые никогда не превращаются в теги и не сканируются.
SKIP_DIRS = {"$recycle.bin", "system volume information", ".git", "__pycache__", "node_modules"}

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def media_type(path: str) -> str | None:
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    return None


def quick_hash(path: str, size: int) -> str:
    """Быстрый «отпечаток» для поиска дублей: размер + начало и конец файла."""
    h = hashlib.sha1(str(size).encode())
    chunk = 64 * 1024
    with open(path, "rb") as f:
        h.update(f.read(chunk))
        if size > chunk * 2:
            f.seek(-chunk, os.SEEK_END)
            h.update(f.read(chunk))
    return h.hexdigest()


def folder_tags(root: str, file_path: str) -> list[str]:
    rel = os.path.relpath(os.path.dirname(file_path), root)
    if rel in (".", ""):
        return []
    parts = [p for p in Path(rel).parts if p.lower() not in SKIP_DIRS]
    return [db.normalize_tag(p) for p in parts if db.normalize_tag(p)]


# ---------------------------------------------------------------- сканирование

_scan_lock = threading.Lock()
scan_status = {"running": False, "added": 0, "updated": 0, "missing": 0, "current": ""}


def scan_all() -> None:
    conn = db.connect()
    for row in conn.execute("SELECT id FROM folders").fetchall():
        scan_folder(row["id"])


def scan_folder(folder_id: int) -> dict:
    with _scan_lock:
        scan_status.update(running=True, added=0, updated=0, missing=0)
        try:
            return _scan_folder(folder_id)
        finally:
            scan_status.update(running=False, current="")
            thumbs.kick()


def _scan_folder(folder_id: int) -> dict:
    conn = db.connect()
    folder = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if not folder:
        return scan_status
    root = folder["path"]
    scan_status["current"] = root
    known = {
        r["path"]: r
        for r in conn.execute("SELECT id, path, size, mtime FROM media WHERE folder_id = ?", (folder_id,))
    }
    seen: set[str] = set()

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d.lower() not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            path = os.path.join(dirpath, fn)
            mtype = media_type(path)
            if not mtype:
                continue
            try:
                st = os.stat(path)
            except OSError:
                continue
            seen.add(path)
            old = known.get(path)
            if old and old["size"] == st.st_size and abs(old["mtime"] - st.st_mtime) < 1:
                continue
            try:
                qh = quick_hash(path, st.st_size)
            except OSError:
                qh = None
            if old:
                conn.execute(
                    "UPDATE media SET size=?, mtime=?, qhash=?, missing=0, thumb_state=0 WHERE id=?",
                    (st.st_size, st.st_mtime, qh, old["id"]),
                )
                scan_status["updated"] += 1
                continue
            name, ext = os.path.splitext(fn)
            mid = conn.execute(
                "INSERT INTO media(folder_id, path, name, ext, type, kind, size, mtime, qhash, added_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (folder_id, path, name, ext.lower().lstrip("."), mtype, folder["kind"],
                 st.st_size, st.st_mtime, qh, time.time()),
            ).lastrowid
            if folder["auto_tags"]:
                for t in folder_tags(root, path):
                    conn.execute("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", (mid, db.tag_id(conn, t)))
            scan_status["added"] += 1

    gone = [k for k in known if k not in seen]
    conn.executemany("UPDATE media SET missing = 1 WHERE path = ?", [(p,) for p in gone])
    # файлы, которые снова появились на месте
    conn.executemany("UPDATE media SET missing = 0 WHERE path = ? AND missing = 1",
                     [(p,) for p in seen if p in known])
    scan_status["missing"] = len(gone)
    return dict(scan_status)


# ---------------------------------------------------------------- превью

def ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


_DUR_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_DIM_RE = re.compile(r"Stream #.*Video:.*?(\d{2,5})x(\d{2,5})")
_ROT_RE = re.compile(r"(?:rotate\s*:\s*|rotation of )(-?\d+)")


def probe_video(path: str) -> tuple[float | None, int | None, int | None]:
    exe = ffmpeg_exe()
    if not exe:
        return None, None, None
    p = subprocess.run([exe, "-hide_banner", "-i", path], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", creationflags=_CREATE_NO_WINDOW, timeout=60)
    out = p.stderr
    dur = w = h = None
    if m := _DUR_RE.search(out):
        dur = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
    if m := _DIM_RE.search(out):
        w, h = int(m[1]), int(m[2])
        if (r := _ROT_RE.search(out)) and abs(int(r[1])) % 180 == 90:
            w, h = h, w
    return dur, w, h


def trash_file(path: str) -> None:
    """В Корзину, а не насовсем: случайно удалённый референс можно вернуть."""
    from send2trash import send2trash
    send2trash(os.path.normpath(path))


def thumb_path(media_id: int) -> Path:
    return db.THUMB_DIR / f"{media_id}.jpg"


def make_thumb(row) -> None:
    out = thumb_path(row["id"])
    conn = db.connect()
    if row["type"] == "image":
        with Image.open(row["path"]) as im:
            w, h = im.size
            if im.getexif().get(0x0112, 1) in (5, 6, 7, 8):  # фото с телефона, повёрнутое через EXIF
                w, h = h, w
            # JPEG умеет декодироваться сразу в уменьшенном виде — в разы быстрее и экономнее по памяти
            im.draft("RGB", (THUMB_SIZE * 2, THUMB_SIZE * 2))
            im = ImageOps.exif_transpose(im)
            im.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
            if im.mode not in ("RGB", "L"):
                bg = Image.new("RGB", im.size, (40, 40, 40))
                im = im.convert("RGBA")
                bg.paste(im, mask=im.getchannel("A"))
                im = bg
            im.save(out, "JPEG", quality=85)
        conn.execute("UPDATE media SET width=?, height=?, thumb_state=1 WHERE id=?", (w, h, row["id"]))
        return

    dur, w, h = probe_video(row["path"])
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg не найден")
    seek = min(dur * 0.1, 30) if dur else 0
    cmd = [exe, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{seek:.2f}", "-i", row["path"],
           "-frames:v", "1", "-vf", f"scale='min({THUMB_SIZE},iw)':-2", str(out)]
    subprocess.run(cmd, capture_output=True, creationflags=_CREATE_NO_WINDOW, timeout=120)
    if not out.exists() and seek:
        cmd[cmd.index("-ss") + 1] = "0"
        subprocess.run(cmd, capture_output=True, creationflags=_CREATE_NO_WINDOW, timeout=120)
    state = 1 if out.exists() else -1
    conn.execute("UPDATE media SET width=?, height=?, duration=?, thumb_state=? WHERE id=?",
                 (w, h, dur, state, row["id"]))


class ThumbWorker:
    """Фоновые потоки: делают превью для всех файлов, у которых их ещё нет."""

    WORKERS = max(1, min(4, (os.cpu_count() or 2) - 1))

    def __init__(self):
        self._wake = queue.Queue()
        self.pending = 0
        threading.Thread(target=self._run, daemon=True, name="thumbs").start()

    def kick(self):
        self._wake.put(1)

    def _one(self, row):
        try:
            make_thumb(row)
        except Exception as e:  # битый файл не должен ронять поток
            log.warning("превью не создано %s: %s", row["path"], e)
            db.connect().execute("UPDATE media SET thumb_state = -1 WHERE id = ?", (row["id"],))
        self.pending = max(0, self.pending - 1)

    def _run(self):
        from concurrent.futures import ThreadPoolExecutor
        pool = ThreadPoolExecutor(self.WORKERS, thread_name_prefix="thumb")
        while True:
            self._wake.get()
            conn = db.connect()
            while True:
                # сначала картинки (свежие — первыми), видео потом: ffmpeg медленнее
                rows = conn.execute(
                    "SELECT id, path, type FROM media WHERE thumb_state = 0 AND missing = 0 "
                    "ORDER BY type = 'video', id DESC LIMIT 64").fetchall()
                self.pending = conn.execute(
                    "SELECT COUNT(*) FROM media WHERE thumb_state = 0 AND missing = 0").fetchone()[0]
                if not rows:
                    break
                list(pool.map(self._one, rows))
            self.pending = 0


thumbs = ThumbWorker()


# ---------------------------------------------------------------- добавление файлов извне

def safe_name(name: str) -> str:
    name = os.path.basename(name.replace("\\", "/"))
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "file"


def target_dir(folder_path: str, subdir: str) -> str:
    sub = [safe_name(p) for p in re.split(r"[\\/]+", subdir or "") if p.strip(" .")]
    dest = os.path.join(folder_path, *sub)
    os.makedirs(dest, exist_ok=True)
    return dest


def unique_path(dest: str, name: str) -> str:
    base, ext = os.path.splitext(safe_name(name))
    target, n = os.path.join(dest, base + ext), 1
    while os.path.exists(target):
        target = os.path.join(dest, f"{base} ({n}){ext}")
        n += 1
    return target


def register_file(conn, folder, path: str, kind: str = "", tags=(), source: str = "") -> int | None:
    """Вносит в каталог файл, уже лежащий в папке библиотеки."""
    mtype = media_type(path)
    if not mtype:
        return None
    st = os.stat(path)
    name, ext = os.path.splitext(os.path.basename(path))
    mid = conn.execute(
        "INSERT INTO media(folder_id, path, name, ext, type, kind, size, mtime, qhash, source, added_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (folder["id"], path, name, ext.lower().lstrip("."), mtype, kind if kind in db.kinds() else folder["kind"],
         st.st_size, st.st_mtime, quick_hash(path, st.st_size), source, time.time())).lastrowid
    for t in tags:
        t = db.normalize_tag(t)
        if t:
            conn.execute("INSERT OR IGNORE INTO media_tags VALUES (?, ?)", (mid, db.tag_id(conn, t)))
    return mid
