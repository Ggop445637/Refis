"""Удаление файлов в Корзину из библиотеки."""
import shutil

from PIL import Image

from conftest import TMP, wait_scan

LIB = TMP / "trash-lib"
BIN = TMP / "recycle-bin"


def listing(client, folder):
    return {m["name"]: m for m in client.get("/api/media", params={"folder": folder["id"]}).json()["items"]}


def test_trash_moves_files_and_forgets_them(client, monkeypatch):
    from refis import media
    LIB.mkdir()
    BIN.mkdir()
    for n in ("keep", "gone", "locked"):
        Image.new("RGB", (200, 200), "teal").save(LIB / f"{n}.jpg")

    def fake_trash(path):
        if path.endswith("locked.jpg"):
            raise OSError("файл занят другой программой")
        shutil.move(path, BIN)

    monkeypatch.setattr(media, "trash_file", fake_trash)
    before = client.get("/api/status").json()["total"]
    folder = client.post("/api/folders", json={"path": str(LIB), "kind": "ref"}).json()
    wait_scan(client, before + 3)
    items = listing(client, folder)
    gone, locked = items["gone"]["id"], items["locked"]["id"]
    client.post("/api/media/bulk", json={"ids": [gone, locked], "add_tags": ["на-удаление"]})
    client.get(f"/api/thumb/{gone}")

    r = client.post("/api/media/trash", json={"ids": [gone, locked, 999999]}).json()
    assert r["ids"] == [gone]
    assert [f["name"] for f in r["failed"]] == ["locked.jpg"]
    assert (BIN / "gone.jpg").exists() and not (LIB / "gone.jpg").exists()
    assert (LIB / "locked.jpg").exists() and (LIB / "keep.jpg").exists()
    assert client.get(f"/api/media/{gone}").status_code == 404
    assert not media.thumb_path(gone).exists()
    assert client.get(f"/api/media/{locked}").json()["tags"] == ["на-удаление"]

    # пересканирование не возвращает удалённое
    client.post("/api/scan")
    wait_scan(client, before + 2)
    names = set(listing(client, folder))
    assert names == {"keep", "locked"}
    client.delete(f"/api/folders/{folder['id']}")


def test_trash_requires_token(client):
    from fastapi.testclient import TestClient

    from refis.server import app
    with TestClient(app, base_url="http://127.0.0.1") as c:
        assert c.post("/api/media/trash", json={"ids": [1]}).status_code == 403
