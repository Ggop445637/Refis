"""Запуск Refis: локальный сервер + окно приложения (или браузер, если окно недоступно)."""
import logging
import os
import socket
import sys
import threading
import time
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


class JsApi:
    """Функции, доступные интерфейсу внутри окна (window.pywebview.api)."""

    def __init__(self):
        self._window = None

    def pick_folder(self):
        import webview
        res = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        return res[0] if res else None


def main() -> None:
    port = int(os.environ.get("REFIS_PORT") or free_port())
    url = f"http://127.0.0.1:{port}"
    from .server import app
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, log_level="warning")
    server = uvicorn.Server(config)

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
                                       min_size=(900, 600), background_color="#16171b")
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
