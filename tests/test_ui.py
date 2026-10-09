"""Интерфейс в настоящем браузере: страницы без ошибок и ввод с клавиатуры.

Нужен Playwright с Chromium: pip install playwright && playwright install chromium
"""
import os
import socket
import threading
import time

import pytest

pw = pytest.importorskip("playwright.sync_api")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def page(client):
    import uvicorn

    from refis.server import app
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    exe = "/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None
    with pw.sync_playwright() as p:
        browser = p.chromium.launch(executable_path=exe)
        pg = browser.new_page(viewport={"width": 1400, "height": 900})
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and pg.errors.append(m.text))
        pg.goto(f"http://127.0.0.1:{port}/")
        pg.wait_for_timeout(1200)
        yield pg
        browser.close()
    server.should_exit = True


@pytest.mark.parametrize("name", ["today", "organize", "library", "boards", "pinterest", "profile", "settings"])
def test_pages_open_without_errors(page, name):
    btn = page.locator(f"[data-page={name}]").first
    if not btn.count():
        pytest.skip(f"страницы {name} нет")
    btn.click()
    page.wait_for_timeout(900)
    assert page.locator(f'.page[data-page="{name}"]').is_visible()
    assert not page.errors, page.errors


def type_into(page, selector, text):
    page.click(selector)
    page.keyboard.type(text)
    return page.input_value(selector)


def test_typing_search(page):
    page.click("#mainNav [data-page=library]")
    page.wait_for_timeout(500)
    assert type_into(page, "#search", "dragon") == "dragon"
    page.fill("#search", "")


def test_typing_prompt_dialog_and_save(page):
    page.click("#saveSearch")
    page.wait_for_timeout(300)
    page.keyboard.press("Control+a")
    page.keyboard.type("Мой поиск")
    assert page.input_value("#mVal") == "Мой поиск"
    page.keyboard.press("Enter")
    page.wait_for_timeout(600)
    assert "Мой поиск" in " ".join(page.locator("#savedlist li").all_inner_texts())  # POST с токеном прошёл


def test_typing_pinterest_link(page):
    page.click("#mainNav [data-page=pinterest]")
    page.wait_for_timeout(700)
    if page.locator("#pinUrl").count():
        assert type_into(page, "#pinUrl", "pinterest.com/artist/x") == "pinterest.com/artist/x"
    else:
        page.click("#pinAdd")
        page.wait_for_timeout(300)
        page.keyboard.type("artist/x")
        assert page.input_value("#cUrl") == "artist/x"
        page.keyboard.press("Escape")


def test_tag_editor_typing(page):
    page.click("#mainNav [data-page=library]")
    page.wait_for_timeout(800)
    page.locator(".card").first.click()
    page.wait_for_timeout(600)
    page.click("#details .tagedit input")
    page.keyboard.type("тест-тег")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    assert "тест-тег" in page.inner_text("#details .tagedit")
    assert not page.errors, page.errors
