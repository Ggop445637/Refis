"""Рекомендации из окна Pinterest: проверка данных со страницы и встраиваемый скрипт."""

import pytest

from conftest import ROOT


def test_collect_feed_validates_input(client):
    from refis import pinterest
    good = {"id": "1234567890", "image": "https://i.pinimg.com/236x/aa/bb/cc/x.jpg", "title": "Gesture"}
    bad = [
        {"id": "12; DROP", "image": good["image"]},
        {"id": "1234567891", "image": "https://evil.example/x.jpg"},
        {"id": "1234567892", "image": "file:///etc/passwd"},
        "not a dict",
    ]
    assert pinterest.collect_feed([good, good] + bad) == 1
    assert pinterest.collect_feed([good]) == 0  # повтор не добавляется
    src = next(s for s in client.get("/api/pinterest/sources").json() if s["kind"] == "feed")
    assert src["title"] == "Рекомендации" and src["new"] >= 1
    # лента рекомендаций не синхронизируется по RSS
    assert client.post(f"/api/pinterest/sources/{src['id']}/sync").json()["added"] == 0


def test_collect_respects_setting(client):
    from refis import pinterest
    client.patch("/api/settings", json={"pinterest_feed": False})
    try:
        assert pinterest.collect_feed([{"id": "2234567890", "image": "https://i.pinimg.com/236x/q.jpg"}]) == 0
    finally:
        client.patch("/api/settings", json={"pinterest_feed": True})


def test_save_from_browser(client, fake_net):
    from refis import pinterest
    if not client.get("/api/folders").json():
        pytest.skip("нет папок")
    r = pinterest.save_from_browser({"id": "3234567890", "image": "https://i.pinimg.com/236x/zz/q.jpg", "title": "Back study"})
    assert r["ok"], r
    m = client.get(f"/api/media/{r['media']}").json()
    assert m["kind"] == "ref" and "pinterest" in m["tags"] and "Сохранённые из ленты" in m["path"]
    again = pinterest.save_from_browser({"id": "3234567890", "image": "https://i.pinimg.com/236x/zz/q.jpg"})
    assert again["ok"] and again["already"]
    assert not pinterest.save_from_browser({"id": "x", "image": "https://i.pinimg.com/a.jpg"})["ok"]


FAKE_PINTEREST = """<!doctype html><html><body><div id="grid">
  <div data-test-id="pin"><a href="/pin/111111111/"><img style="width:236px;height:300px;display:block" src="https://i.pinimg.com/236x/a/1.jpg"
     srcset="https://i.pinimg.com/236x/a/1.jpg 1x, https://i.pinimg.com/474x/a/1.jpg 2x" alt="Hands"></a></div>
  <div data-test-id="pin"><a href="/pin/222222222/"><img style="width:236px;height:300px;display:block" src="https://i.pinimg.com/236x/b/2.jpg" alt="Torso"></a></div>
  <div><a href="/settings/">не пин</a></div>
</div></body></html>"""


def test_bridge_script_on_fake_feed():
    pw = pytest.importorskip("playwright.sync_api")
    import os
    script = (ROOT / "refis" / "static" / "pinterest-bridge.js").read_text(encoding="utf-8")
    exe = "/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None
    with pw.sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe)
        pg = b.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        # подменяем «pinterest.com» и мост pywebview
        pg.route("https://www.pinterest.com/**", lambda r: r.fulfill(body=FAKE_PINTEREST, content_type="text/html"))
        pg.route("https://i.pinimg.com/**", lambda r: r.fulfill(status=404))
        pg.add_init_script("""window.__calls = {collect: [], save: []};
          window.pywebview = {api: {collect: async (b) => { window.__calls.collect.push(...b); return b.length; },
                                    save: async (x) => { window.__calls.save.push(x); return {ok: true}; }}};""")
        pg.goto("https://www.pinterest.com/")
        pg.evaluate(script)
        pg.wait_for_timeout(2600)
        calls = pg.evaluate("window.__calls")
        assert {c["id"] for c in calls["collect"]} == {"111111111", "222222222"}
        assert calls["collect"][0]["image"].endswith("/474x/a/1.jpg")  # крупнейший из srcset
        assert pg.locator(".refis-save").count() == 2
        pg.hover('[data-test-id="pin"] >> nth=0')
        pg.click('.refis-save >> nth=0')
        pg.wait_for_timeout(300)
        assert pg.evaluate("window.__calls.save")[0]["id"] == "111111111"
        assert "В Refis" in pg.inner_text(".refis-save >> nth=0")
        pg.evaluate(script)  # повторная вставка не дублирует кнопки
        pg.wait_for_timeout(400)
        assert pg.locator(".refis-save").count() == 2
        # на странице поиска пины не собираются как рекомендации, но кнопка есть
        pg.goto("https://www.pinterest.com/search/pins/?q=hands")
        pg.evaluate("window.__calls.collect = []")
        pg.evaluate(script)
        pg.wait_for_timeout(2300)
        assert pg.evaluate("window.__calls.collect") == [] and pg.locator(".refis-save").count() == 2
        assert not errors, errors
        b.close()
