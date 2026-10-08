"""SQLite-хранилище каталога: папки, файлы, теги, сохранённые поиски."""
import os
import sqlite3
import threading
from pathlib import Path

DATA_DIR = Path(os.environ.get("REFIS_DATA") or Path(__file__).resolve().parent.parent / "data")
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "refis.db"

KINDS = ("ref", "own", "tutorial", "other")

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
"""

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
    connect().executescript(SCHEMA)


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
