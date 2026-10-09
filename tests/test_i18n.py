"""Переводы: у каждой строки интерфейса и сервера есть английский вариант, переключение работает."""
import ast
import subprocess
import sys

from conftest import ROOT


def test_all_ui_strings_translated():
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "i18n_keys.py"), "--missing"], capture_output=True, text=True)
    missing = [line for line in r.stdout.splitlines() if line.startswith("НЕТ ПЕРЕВОДА")]
    assert not missing, "\n".join(missing)


def test_all_server_strings_translated():
    from refis.i18n import EN
    keys = set()
    for f in (ROOT / "refis").glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "tr" and node.args \
                    and isinstance(node.args[0], ast.Constant):
                keys.add(node.args[0].value)
    from refis.organize import RULES
    keys |= set(RULES)
    missing = sorted(k for k in keys if k not in EN)
    assert not missing, missing


def test_server_messages_follow_language(client):
    try:
        client.patch("/api/settings", json={"lang": "en"})
        r = client.post("/api/folders", json={"path": "/definitely/not/here"})
        assert r.status_code == 400 and r.json()["detail"].startswith("Folder not found")
        ach = client.get("/api/profile").json()["achievements"]
        assert ach[0]["title"] == "First step"
        ch = client.get("/api/challenge").json()
        assert ch["ctype"] == "none" or not any("а" <= c <= "я" for c in ch["rule"])
    finally:
        client.patch("/api/settings", json={"lang": "ru"})
    assert client.post("/api/folders", json={"path": "/definitely/not/here"}).json()["detail"].startswith("Папка не найдена")


def test_english_ui_in_browser(client):
    pw = __import__("pytest").importorskip("playwright.sync_api")
    import os
    import socket
    import threading
    import time

    import uvicorn

    from refis.server import app
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    client.patch("/api/settings", json={"lang": "en"})
    exe = "/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None
    try:
        with pw.sync_playwright() as p:
            b = p.chromium.launch(executable_path=exe)
            pg = b.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(f"http://127.0.0.1:{port}/")
            pg.wait_for_timeout(2500)  # первая загрузка запоминает язык и перезагружает окно
            assert pg.evaluate("document.documentElement.lang") == "en"
            assert "Library" in pg.inner_text("#mainNav") and "Библиотека" not in pg.inner_text("#mainNav")
            for page in ("today", "organize", "library", "boards", "pinterest", "profile", "settings"):
                pg.click(f"[data-page={page}]")
                pg.wait_for_timeout(700)
                text = pg.inner_text(f'.page[data-page="{page}"]')
                # русские буквы допустимы только в пользовательских данных (имена файлов и тегов из тестов)
                russian_ui = [w for w in ("Добавить", "Настройки", "Сегодня", "Порядок в", "Сохранить", "Тренировка") if w in text]
                assert not russian_ui, (page, russian_ui)
            assert not errors, errors
            b.close()
    finally:
        client.patch("/api/settings", json={"lang": "ru"})
        server.should_exit = True
