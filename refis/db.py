"""SQLite-хранилище каталога: папки, файлы, теги, сохранённые поиски."""
import os
import sqlite3
import sys
import threading
from pathlib import Path


def _data_dir() -> Path:
    if os.environ.get("REFIS_DATA"):
        return Path(os.environ["REFIS_DATA"])
    if getattr(sys, "frozen", False):
        # .exe: папка data рядом с программой (портативный режим) или %LOCALAPPDATA%\Refis
        portable = Path(sys.executable).resolve().parent / "data"
        if portable.is_dir():
            return portable
        return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Refis"
    return Path(__file__).resolve().parent.parent / "data"


DATA_DIR = _data_dir()
THUMB_DIR = DATA_DIR / "thumbs"
ASSET_DIR = DATA_DIR / "board_assets"
PIN_DIR = DATA_DIR / "pins"
DB_PATH = DATA_DIR / "refis.db"

# Разделы библиотеки (media.kind). Встроенные есть всегда при создании базы; свои добавляет пользователь.
BUILTIN_KINDS = ("ref", "own", "tutorial", "other")
CORE_KINDS = ("ref", "own")  # на них опираются задания, профиль и Pinterest — удалить нельзя
DEFAULT_COLORS = {"ref": "#6aa8ff", "own": "#ffb35c", "tutorial": "#5ee6a0", "other": "#b48cff"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'ref',
    auto_tags INTEGER NOT NULL DEFAULT 1,
    added_at REAL NOT NULL DEFAULT (CAST(strftime('%s','now') AS REAL))
);
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    type TEXT NOT NULL,              -- image | video
    kind TEXT NOT NULL DEFAULT 'ref',-- ref | own | tutorial | other
    size INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0,
    qhash TEXT,
    width INTEGER,
    height INTEGER,
    duration REAL,
    title TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0,
    thumb_state INTEGER NOT NULL DEFAULT 0, -- 0 нет, 1 готово, -1 ошибка
    added_at REAL NOT NULL DEFAULT (CAST(strftime('%s','now') AS REAL))
);
CREATE INDEX IF NOT EXISTS media_folder ON media(folder_id);
CREATE INDEX IF NOT EXISTS media_qhash ON media(qhash);
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS media_tags (
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, tag_id)
);
CREATE INDEX IF NOT EXISTS media_tags_tag ON media_tags(tag_id);
CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_log (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,            -- gesture | challenge
    count INTEGER NOT NULL DEFAULT 0,
    seconds REAL NOT NULL DEFAULT 0,
    prompt TEXT NOT NULL DEFAULT '',
    media_id INTEGER
);
CREATE INDEX IF NOT EXISTS practice_ts ON practice_log(ts);
CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{"items":[]}',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS pin_sources (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,      -- RSS-лента доски или профиля
    page TEXT NOT NULL,            -- обычная ссылка на Pinterest
    kind TEXT NOT NULL,            -- board | user
    title TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    folder_id INTEGER,
    auto_save INTEGER NOT NULL DEFAULT 0,
    last_sync REAL,
    last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    source_id INTEGER NOT NULL REFERENCES pin_sources(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL,           -- ссылка на картинку из ленты
    published REAL,
    status TEXT NOT NULL DEFAULT 'new',  -- new | saved | hidden
    media_id INTEGER,
    added_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS pins_status ON pins(status);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sections (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',   -- пусто у встроенных — тогда имя по языку интерфейса
    color TEXT NOT NULL DEFAULT '',
    pos INTEGER NOT NULL DEFAULT 0
);
"""

# Колонки, добавленные после первой версии: (таблица, колонка, определение)
MIGRATIONS = [
    ("media", "last_viewed", "REAL"),
    ("media", "view_count", "INTEGER NOT NULL DEFAULT 0"),
    ("practice_log", "tag", "TEXT NOT NULL DEFAULT ''"),
    ("practice_log", "ctype", "TEXT NOT NULL DEFAULT ''"),
]

_local = threading.local()


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        _local.conn = conn
    return conn


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    PIN_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    conn.executescript(SCHEMA)
    for table, col, decl in MIGRATIONS:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    if not conn.execute("SELECT 1 FROM sections LIMIT 1").fetchone():  # новая база или обновление со старой версии
        conn.executemany("INSERT INTO sections(key, color, pos) VALUES (?, ?, ?)",
                         [(k, DEFAULT_COLORS[k], i) for i, k in enumerate(BUILTIN_KINDS)])


def kinds() -> tuple:
    """Ключи разделов по порядку."""
    return tuple(r[0] for r in connect().execute("SELECT key FROM sections ORDER BY pos, rowid"))


def tag_id(conn: sqlite3.Connection, name: str) -> int:
    name = normalize_tag(name)
    row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    return conn.execute("INSERT INTO tags(name) VALUES (?)", (name,)).lastrowid


def normalize_tag(name: str) -> str:
    return " ".join(name.replace(",", " ").strip().lstrip("#").lower().split())


def cleanup_tags(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM media_tags)")
