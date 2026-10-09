"""Запуск Refis: локальный сервер + окно приложения (или браузер, если окно недоступно)."""
import logging
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

import uvicorn

from . import db

db.DATA_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(db.DATA_DIR / "refis.log", encoding="utf-8")]
    + ([logging.StreamHandler()] if sys.stderr else []),
)
log = logging.getLogger("refis")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_ready(url: str, timeout: float = 20) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url + "/api/status", timeout=1)
            return
        except Exception:
            time.sleep(0.15)


class PinterestBridge:
    """Единственное, что доступно странице pinterest.com в окне Refis: передать пины. Данные проверяются."""

    def collect(self, items):
        from .pinterest import collect_feed
        return collect_feed(items if isinstance(items, list) else [])

    def save(self, item):
        from .pinterest import save_from_browser
        return save_from_browser(item)


class JsApi:
    """Функции, доступные интерфейсу внутри окна (window.pywebview.api)."""

    def __init__(self):
        self._window = None
        self._pin = None

    def open_pinterest(self, url="https://www.pinterest.com/"):
        """Окно с настоящим pinterest.com: вход в аккаунт запоминается, на пинах — кнопка «＋ Refis»."""
        import webview
        if not str(url).startswith("https://www.pinterest.com/"):
            url = "https://www.pinterest.com/"
        if self._pin is not None:
            try:
                self._pin.restore()
                self._pin.show()
                return True
            except Exception:
                self._pin = None
        from pathlib import Path
        script = (Path(__file__).resolve().parent / "static" / "pinterest-bridge.js").read_text(encoding="utf-8")
        win = webview.create_window("Pinterest — Refis", url, js_api=PinterestBridge(), width=1280, height=900,
                                    background_color="#ffffff")

        def inject():
            try:
                win.evaluate_js(script)
            except Exception as e:
                log.warning("pinterest bridge: %s", e)

        def closed():
            self._pin = None

        win.events.loaded += inject
        win.events.closed += closed
        self._pin = win
        return True

    def pick_folder(self):
        import webview
        res = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        return res[0] if res else None

    def set_on_top(self, value):
        self._window.on_top = bool(value)
        return bool(value)

    def toggle_fullscreen(self):
        self._window.toggle_fullscreen()

    def restart(self):
        """Перезапуск — нужен, например, после восстановления из резервной копии."""
        import subprocess
        frozen = getattr(sys, "frozen", False)
        cmd = [sys.executable] + ([] if frozen else ["-m", "refis"]) + [a for a in sys.argv[1:] if a != "--selftest"]
        cwd = os.path.dirname(sys.executable) if frozen else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        subprocess.Popen(cmd, cwd=cwd)
        self._window.destroy()


def selftest(url: str) -> int:
    """Проверка собранной программы (используется в CI): сервер, интерфейс, ffmpeg."""
    from . import media
    wait_ready(url)
    try:
        for path in ("/api/status", "/", "/js/main.js", "/css/style.css", "/api/stats"):
            with urllib.request.urlopen(url + path, timeout=10) as r:
                assert r.status == 200, path
                if path.endswith(".js"):
                    assert "javascript" in r.headers.get("Content-Type", ""), r.headers.get("Content-Type")
        assert media.ffmpeg_exe(), "ffmpeg не найден"
        from send2trash import send2trash
        assert callable(send2trash), "send2trash не попал в сборку"
        req = urllib.request.Request(url + "/api/scan", method="POST")
        try:
            urllib.request.urlopen(req, timeout=10)
            raise AssertionError("POST без токена должен отклоняться")
        except urllib.error.HTTPError as e:
            assert e.code == 403, e.code
        print("SELFTEST OK")
        return 0
    except Exception as e:
        print("SELFTEST FAILED:", repr(e))
        return 1


def main() -> None:
    port = int(os.environ.get("REFIS_PORT") or free_port())
    url = f"http://127.0.0.1:{port}"
    from .server import app
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, log_level="warning")
    server = uvicorn.Server(config)

    if "--selftest" in sys.argv:
        threading.Thread(target=server.run, daemon=True).start()
        code = selftest(url)
        log.info("selftest: %s", "OK" if code == 0 else "FAILED")
        (db.DATA_DIR / "selftest.txt").write_text(str(code))
        if sys.stdout:
            sys.stdout.flush()
        os._exit(code)

    if "--browser" in sys.argv:
        threading.Thread(target=lambda: (wait_ready(url), webbrowser.open(url)), daemon=True).start()
        server.run()
        return

    try:
        import webview
    except Exception as e:  # pywebview не установлен — работаем через браузер
        log.warning("Окно недоступно (%s), открываю в браузере", e)
        threading.Thread(target=lambda: (wait_ready(url), webbrowser.open(url)), daemon=True).start()
        server.run()
        return

    threading.Thread(target=server.run, daemon=True).start()
    wait_ready(url)
    api = JsApi()
    api._window = webview.create_window("Refis", url, js_api=api, width=1500, height=950,
                                       min_size=(900, 600), background_color="#0c0c10")
    try:
        webview.start(private_mode=False, storage_path=str(db.DATA_DIR / "webview"))
    except Exception as e:
        log.warning("Окно не запустилось (%s), открываю в браузере", e)
        webbrowser.open(url)
        while True:
            time.sleep(3600)
    server.should_exit = True


if __name__ == "__main__":
    main()
