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


def test_delete_from_viewer_moves_to_next(page, client, monkeypatch):
    import shutil

    from PIL import Image

    from conftest import TMP, wait_scan
    from refis import media
    lib, trash = TMP / "ui-trash", TMP / "ui-bin"
    lib.mkdir()
    trash.mkdir()
    for n in ("uitrash_a", "uitrash_b"):
        Image.new("RGB", (300, 300), "purple").save(lib / f"{n}.jpg")
    monkeypatch.setattr(media, "trash_file", lambda p: shutil.move(p, trash))
    before = client.get("/api/status").json()["total"]
    folder = client.post("/api/folders", json={"path": str(lib), "kind": "ref"}).json()
    wait_scan(client, before + 2)

    page.click("#mainNav [data-page=library]")
    page.fill("#search", "uitrash")
    page.wait_for_timeout(900)
    assert page.locator(".card").count() == 2
    page.locator(".card").first.dblclick()
    page.wait_for_timeout(700)
    first = page.inner_text("#vTitle b")
    page.keyboard.press("Delete")
    page.wait_for_timeout(300)
    page.click("#mOk")
    page.wait_for_timeout(1200)
    assert not (lib / f"{first}.jpg").exists() and (trash / f"{first}.jpg").exists()
    assert page.is_visible("#viewer") and page.inner_text("#vTitle b") not in ("", first)
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)
    assert page.locator(".card").count() == 1
    assert not page.errors, page.errors
    page.fill("#search", "")
    client.delete(f"/api/folders/{folder['id']}")


def test_video_frame_and_ab_loop(page, client):
    page.click("#mainNav [data-page=library]")
    page.fill("#search", "урок_торс")
    page.wait_for_timeout(900)
    before = page.locator(".card").count()
    vid = next(m["id"] for m in client.get("/api/media", params={"q": "урок_торс", "type": "video"}).json()["items"])
    page.locator(f'.card[data-id="{vid}"]').dblclick()
    page.wait_for_function("document.querySelector('#vStage video')?.readyState >= 2", timeout=10000)
    video = "document.querySelector('#vStage video')"
    page.evaluate(f"{video}.muted = true; {video}.pause(); {video}.currentTime = 0.5")
    page.wait_for_timeout(300)
    page.keyboard.press("x")
    page.evaluate(f"{video}.currentTime = 1.5")
    page.wait_for_timeout(300)
    page.keyboard.press("x")
    assert page.is_visible("#vAB") and "✓" in page.inner_text('[data-act="ab"]')
    page.wait_for_timeout(2500)  # дольше отрезка — значит, видео вернулось к A
    t = page.evaluate(f"{video}.currentTime")
    assert 0.4 <= t <= 1.7, t
    page.keyboard.press("k")
    page.wait_for_timeout(1500)
    assert "Кадр сохранён" in page.inner_text("#toasts")
    page.keyboard.press("Escape")
    page.wait_for_timeout(800)
    assert page.locator(".card").count() == before + 1
    assert not page.errors, page.errors
    page.fill("#search", "")


def test_pack_export_and_import_dialogs(page, client, monkeypatch):
    from conftest import TMP
    from refis import packs, server
    out = TMP / "packs-ui"
    monkeypatch.setattr(packs, "packs_dir", lambda: out)
    monkeypatch.setattr(server, "_reveal", lambda p: None)
    page.click("#mainNav [data-page=library]")
    page.fill("#search", "pose_")
    page.wait_for_timeout(900)
    page.locator(".card").first.click()
    page.keyboard.press("Control+a")
    page.wait_for_timeout(300)
    page.click("#bPack")
    page.wait_for_selector("#kName")
    page.fill("#kName", "Мои позы")
    page.click("#kOk")
    page.wait_for_timeout(1200)
    pack = out / "Мои позы.refis"
    assert pack.exists()

    page.click("#mainNav [data-page=boards]")
    page.wait_for_timeout(600)
    with page.expect_file_chooser() as fc:
        page.click("#bOpenPack")
    fc.value.set_files(str(pack))
    page.wait_for_selector(".packprev img")
    assert "Мои позы" in page.inner_text("#modal h2")
    page.click("#kOk")
    page.wait_for_timeout(1500)
    assert "Набор добавлен" in page.inner_text("#toasts")
    assert page.is_visible('.page[data-page="library"]')
    assert not page.errors, page.errors
    page.fill("#search", "")


def test_repeated_navigation_starts_one_transition(page):
    page.click("#mainNav [data-page=boards]")
    page.wait_for_timeout(600)
    n = page.evaluate("""async () => {
      let n = 0;
      const orig = document.startViewTransition?.bind(document);
      if (orig) document.startViewTransition = (fn) => { n++; return orig(fn); };
      const u = await import('/js/util.js');
      u.emit('navigate', 'library'); u.emit('navigate', 'library');
      if (orig) document.startViewTransition = orig;
      return orig ? n : 1;
    }""")
    page.wait_for_timeout(600)
    assert n == 1
    assert page.is_visible('.page[data-page="library"]')
    assert not page.errors, page.errors


def test_create_folder_and_drag_cards_into_it(page, client):
    from conftest import TMP
    page.click("#mainNav [data-page=library]")
    page.click("#addFolder")
    page.click("#ctxmenu button:has-text('Создать новую папку')")
    page.wait_for_function("document.activeElement?.id === 'nName'")  # окно открылось и поставило фокус
    page.fill("#nName", "Перетащить сюда")
    page.select_option("#nWhere", "new")
    page.fill("#nParent", str(TMP / "ui-made"))
    page.click("#nOk")
    page.wait_for_function("document.querySelector('#toasts').innerText.includes('Перетащить сюда')", timeout=15000)
    root = TMP / "ui-made" / "Перетащить сюда"
    import os
    assert root.is_dir(), (os.listdir(TMP / "ui-made"), [f["path"] for f in client.get("/api/folders").json()])
    fid = next(f["id"] for f in client.get("/api/folders").json() if f["path"] == str(root))

    page.locator(f'#folderlist li[data-id="{fid}"][data-sub=""]').click(button="right")
    page.click("#ctxmenu button:has-text('Новая подпапка')")
    page.wait_for_function("document.activeElement?.id === 'nName'")
    page.fill("#nName", "Руки")
    page.click("#nOk")
    page.wait_for_function("document.querySelector('#toasts').innerText.includes('Папка создана: Руки')", timeout=15000)
    page.wait_for_timeout(500)
    assert (root / "Руки").is_dir()
    sub = page.locator(f'#folderlist li[data-id="{fid}"][data-sub="Руки"]')
    assert sub.is_visible() and "active" in sub.get_attribute("class")

    sub.click()  # снять фильтр по папке
    page.fill("#search", "pose_b")
    page.wait_for_timeout(900)
    page.locator(".card").first.drag_to(sub)
    page.wait_for_timeout(1500)
    assert (root / "Руки" / "pose_b.jpg").exists()
    assert "Перемещено" in page.inner_text("#toasts")
    assert page.locator(f'#folderlist li[data-id="{fid}"][data-sub="Руки"] .cnt').inner_text() == "1"
    assert not page.is_visible("#dropzone")
    assert not page.errors, page.errors
    page.fill("#search", "")


def test_custom_section_create_drag_rename_export_delete(page, client, monkeypatch):
    from conftest import TMP
    from refis import packs, server
    monkeypatch.setattr(packs, "packs_dir", lambda: TMP / "packs-sec")
    monkeypatch.setattr(server, "_reveal", lambda p: None)
    toasts = "document.querySelector('#toasts').innerText"
    page.click("#mainNav [data-page=library]")
    page.click("#views [data-add-section]")
    page.wait_for_function("document.activeElement?.id === 'sName'")
    page.fill("#sName", "Пейзажи")
    page.click("#sColors [data-c='#ff6b8b']")
    page.click("#sOk")
    page.wait_for_function(f"{toasts}.includes('Раздел создан')", timeout=10000)
    btn = page.locator("#views [data-section]", has_text="Пейзажи")
    assert btn.is_visible() and "active" in btn.get_attribute("class")
    key = btn.get_attribute("data-view")
    assert next(s for s in client.get("/api/sections").json() if s["key"] == key)["color"] == "#ff6b8b"

    page.click("#views [data-view=all]")
    page.fill("#search", "pose_a")
    page.wait_for_timeout(900)
    mid = int(page.locator(".card").first.get_attribute("data-id"))
    page.locator(".card").first.drag_to(btn)
    page.wait_for_function(f"{toasts}.includes('Пейзажи')", timeout=10000)
    page.wait_for_timeout(500)
    assert client.get(f"/api/media/{mid}").json()["kind"] == key
    color = page.eval_on_selector(f'.card[data-id="{mid}"] .dot.kind', "e => getComputedStyle(e).backgroundColor")
    assert color == "rgb(255, 107, 139)"

    btn.click(button="right")
    page.click("#ctxmenu button:has-text('Переименовать')")
    page.wait_for_function("document.activeElement?.id === 'sName'")
    page.fill("#sName", "Природа")
    page.click("#sOk")
    page.wait_for_timeout(1000)
    sec = page.locator(f'#views [data-view="{key}"]')
    assert "Природа" in sec.inner_text()

    sec.click(button="right")
    page.click("#ctxmenu button:has-text('Экспорт раздела')")
    page.wait_for_selector("#kName")
    page.click("#kOk")
    page.wait_for_function(f"{toasts}.includes('Набор сохранён')", timeout=10000)
    assert list((TMP / "packs-sec").glob("*.refis"))

    sec.click(button="right")
    page.click("#ctxmenu button:has-text('Удалить раздел')")
    page.wait_for_selector("#dOk")
    page.select_option("#dTo", "ref")
    page.click("#dOk")
    page.wait_for_function(f"{toasts}.includes('Раздел удалён')", timeout=10000)
    page.wait_for_timeout(500)
    assert not page.locator(f'#views [data-view="{key}"]').count()
    assert client.get(f"/api/media/{mid}").json()["kind"] == "ref"
    assert not page.errors, page.errors
    page.fill("#search", "")
