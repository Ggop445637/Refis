"""Настройки, резервные копии, восстановление, проверка обновлений."""
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

from conftest import ROOT, TMP


def test_settings_defaults_and_patch(client):
    s = client.get("/api/settings").json()
    assert s["theme"] == "dark" and s["lang"] == "ru"
    s = client.patch("/api/settings", json={"theme": "light", "ambient": False}).json()
    assert s["theme"] == "light" and s["ambient"] is False
    assert client.patch("/api/settings", json={"nope": 1}).status_code == 400
    assert client.patch("/api/settings", json={"ambient": "yes"}).status_code == 400
    client.patch("/api/settings", json={"theme": "dark", "ambient": True})


def test_about_and_report(client):
    a = client.get("/api/about").json()
    assert a["version"] and a["repo"]
    url = client.get("/api/report-url").json()["url"]
    assert url.startswith(f"https://github.com/{a['repo']}/issues/new?body=") and a["version"] in url
    assert str(TMP) not in url  # без личных путей


def test_open_url_only_web(client):
    assert client.post("/api/open-url", json={"url": "file:///etc/passwd"}).status_code == 400


def test_update_check(client, monkeypatch):
    from refis import system
    rel = {"tag_name": "v99.0.0", "html_url": "https://github.com/x/y/releases/tag/v99.0.0", "body": "Новое",
           "assets": [{"name": "Refis-Setup-99.0.0.exe", "browser_download_url": "https://dl/setup.exe"}]}
    monkeypatch.setattr(system, "http_get", lambda *a, **k: (json.dumps(rel).encode(), "application/json", ""))
    u = client.get("/api/update?force=true").json()
    assert u["newer"] and u["latest"] == "99.0.0" and u["download"] == "https://dl/setup.exe"
    rel["tag_name"] = "v0.1.0"
    assert not client.get("/api/update?force=true").json()["newer"]

    def offline(*a, **k):
        raise OSError("offline")
    monkeypatch.setattr(system, "http_get", offline)
    u = client.get("/api/update?force=true").json()
    assert not u["newer"] and "error" in u


def test_version_compare():
    from refis.system import _ver
    assert _ver("2.10.0") > _ver("2.9.9") > _ver("2.9") and _ver("v3") == (3, 0, 0)


def test_backup_and_restore_roundtrip(client, tmp_path):
    client.post("/api/saved", json={"name": "Для копии", "query": {}})
    r = client.post("/api/backup").json()
    zpath = Path(r["path"])
    with zipfile.ZipFile(zpath) as z:
        assert "refis.db" in z.namelist()
    assert any(b["path"] == str(zpath) for b in client.get("/api/backups").json())

    # восстановление в отдельной «установке»: копия применяется при запуске
    data2 = tmp_path / "data2"
    code = f"""
import os, sys, shutil
os.environ['REFIS_DATA'] = r'{data2}'
sys.path.insert(0, r'{ROOT}')
from refis import db, system
db.DATA_DIR.mkdir(parents=True, exist_ok=True); db.ASSET_DIR.mkdir(parents=True, exist_ok=True)
system._stage_restore(__import__('pathlib').Path(r'{zpath}'))
assert system.apply_pending_restore()
db.init()
print([r['name'] for r in db.connect().execute('SELECT name FROM saved_searches')])
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env={**os.environ})
    assert out.returncode == 0, out.stderr
    assert "Для копии" in out.stdout


def test_restore_rejects_bad_archives(client, tmp_path):
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("hello.txt", "x")
    r = client.post("/api/restore", files={"file": ("bad.zip", bad.read_bytes(), "application/zip")})
    assert r.status_code == 400
    r = client.post("/api/restore", files={"file": ("x.zip", b"not a zip", "application/zip")})
    assert r.status_code == 400
    evil = tmp_path / "evil.zip"
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr("refis.db", b"SQLite format 3\x00" + b"0" * 100)
        z.writestr("../../escape.txt", "x")
    r = client.post("/api/restore", files={"file": ("evil.zip", evil.read_bytes(), "application/zip")})
    assert r.status_code == 400


def test_release_notes_on_windows_console(tmp_path):
    """Описание релиза собирается и при консоли cp1252, как на сборочной машине Windows."""
    out = tmp_path / "notes.md"
    env = {**os.environ, "PYTHONIOENCODING": "cp1252"}
    from refis import __version__
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "changelog_section.py"), __version__, str(out)],
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    text = out.read_text(encoding="utf-8")
    assert "SmartScreen" in text and len(text) > 200  # раздел версии найден в CHANGELOG.md
