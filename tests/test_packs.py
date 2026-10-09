"""Наборы референсов (.refis) и кадры из видео."""
import io
import json
import zipfile

from PIL import Image

from conftest import TMP, jpeg_bytes, make_video, wait_scan

SRC = TMP / "pack-src"
DST = TMP / "pack-dst"
state = {}


def listing(client, folder_id):
    return {m["name"]: m for m in client.get("/api/media", params={"folder": folder_id}).json()["items"]}


def test_export_pack_with_board(client, monkeypatch):
    from refis import packs
    monkeypatch.setattr(packs, "packs_dir", lambda: TMP / "packs-out")
    for n, c in (("pose_a", "red"), ("pose_b", "green"), ("my_sketch", "blue")):
        SRC.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (200, 300), c).save(SRC / f"{n}.jpg")
    before = client.get("/api/status").json()["total"]
    src = client.post("/api/folders", json={"path": str(SRC), "kind": "ref", "auto_tags": False}).json()
    wait_scan(client, before + 3)
    items = listing(client, src["id"])
    a, b, own = items["pose_a"]["id"], items["pose_b"]["id"], items["my_sketch"]["id"]
    client.patch(f"/api/media/{a}", json={"tags": ["поза", "анатомия/торс"], "notes": "смотри на вес", "rating": 4})
    client.patch(f"/api/media/{own}", json={"kind": "own"})
    asset = client.post("/api/board-assets", files={"file": ("x.png", jpeg_bytes(size=(50, 50)), "image/png")}).json()["src"]
    board = {"items": [
        {"id": "i1", "type": "media", "mid": a, "mtype": "image", "src": f"/api/file/{a}", "x": 0, "y": 0, "w": 200, "h": 300, "z": 1},
        {"id": "i2", "type": "media", "mid": 999999, "mtype": "image", "src": "/api/file/999999", "x": 0, "y": 0, "w": 1, "h": 1, "z": 2},
        {"id": "i3", "type": "asset", "src": asset, "x": 300, "y": 0, "w": 50, "h": 50, "z": 3},
        {"id": "i4", "type": "note", "text": "линия действия", "x": 0, "y": 400, "w": 200, "h": 80, "z": 4},
    ], "view": {"x": 0, "y": 0, "z": 1}}
    bid = client.post("/api/boards", json={"name": "Позы", "data": board}).json()["id"]

    est = client.post("/api/packs/estimate", json={"ids": [b, own, a], "board_id": bid}).json()
    assert est["count"] == 3 and est["size"] > 0

    r = client.post("/api/packs/export", json={"name": "Позы: торс", "author": "Ne_Mocrui", "ids": [b, own], "board_id": bid}).json()
    assert r["count"] == 3 and r["path"].endswith(".refis") and ":" not in r["path"].rsplit("/", 1)[-1]
    with zipfile.ZipFile(r["path"]) as z:
        m = json.loads(z.read("refis-pack.json"))
        assert [i["name"] for i in m["items"]] == ["pose_a", "pose_b", "my_sketch"]
        assert m["items"][0]["tags"] == ["анатомия/торс", "поза"] and m["items"][0]["notes"] == "смотри на вес"
        assert [i["type"] for i in m["board"]["items"]] == ["media", "asset", "note"]
        assert m["board"]["items"][0]["item"] == 0 and "mid" not in m["board"]["items"][0]
        assert m["board"]["items"][1]["src"] in z.namelist()
    without_notes = client.post("/api/packs/export", json={"name": "Позы: торс", "ids": [a], "notes": False}).json()
    assert without_notes["path"] != r["path"]
    with zipfile.ZipFile(without_notes["path"]) as z:
        assert json.loads(z.read("refis-pack.json"))["items"][0]["notes"] == ""
    state.update(pack=r["path"], a=a)


def test_inspect_and_import(client):
    with open(state["pack"], "rb") as f:
        info = client.post("/api/packs/inspect", files={"file": ("p.refis", f, "application/zip")}).json()
    assert info["name"] == "Позы: торс" and info["author"] == "Ne_Mocrui" and info["count"] == 3 and info["board"]
    assert "поза" in info["tags"] and info["preview"] == [0, 1, 2]
    pv = client.get(f"/api/packs/inbox/{info['token']}/preview/0")
    assert pv.status_code == 200 and pv.headers["content-type"] == "image/jpeg"

    DST.mkdir()
    dst = client.post("/api/folders", json={"path": str(DST), "kind": "ref"}).json()
    # все три файла уже есть в библиотеке — второй экземпляр не создаётся, но тег набора добавляется
    r = client.post("/api/packs/import", json={"token": info["token"], "folder_id": dst["id"], "tag": "набор/позы"}).json()
    assert r["added"] == [] and len(r["existing"]) == 3
    assert "набор/позы" in client.get(f"/api/media/{state['a']}").json()["tags"]
    assert not list(DST.rglob("*.jpg"))
    board = client.get(f"/api/boards/{r['board_id']}").json()
    assert board["name"] == "Позы"
    kinds = [i["type"] for i in board["data"]["items"]]
    assert kinds == ["media", "asset", "note"]
    assert board["data"]["items"][0]["mid"] == state["a"]
    asset_src = board["data"]["items"][1]["src"]
    assert client.get(asset_src).status_code == 200
    # токен одноразовый
    assert client.post("/api/packs/import", json={"token": info["token"], "folder_id": dst["id"]}).status_code == 404
    state["dst"] = dst["id"]


def test_import_new_files_keeps_tags_and_turns_own_into_refs(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("refis-pack.json", json.dumps({"format": 1, "name": "Чужой набор", "items": [
            {"file": "files/new_one.jpg", "kind": "own", "tags": ["драпировка"], "notes": "n", "rating": 9, "source": "artstation"},
            {"file": "files/../../evil.jpg", "tags": []},
            {"file": "files/readme.txt"},
        ]}))
        z.writestr("files/new_one.jpg", jpeg_bytes("navy"))
        z.writestr("files/../../evil.jpg", jpeg_bytes("black"))
        z.writestr("files/readme.txt", "hi")
    info = client.post("/api/packs/inspect", files={"file": ("x.refis", buf.getvalue())}).json()
    assert info["count"] == 2 and not info["board"]
    r = client.post("/api/packs/import", json={"token": info["token"], "folder_id": state["dst"], "board": True}).json()
    assert len(r["added"]) == 2 and r["board_id"] is None
    files = sorted(p.relative_to(DST).as_posix() for p in DST.rglob("*.jpg"))
    assert files == ["Чужой набор/evil.jpg", "Чужой набор/new_one.jpg"]  # «../» не выводит за папку
    m = client.get(f"/api/media/{r['added'][0]}").json()
    assert m["kind"] == "ref" and m["tags"] == ["драпировка"] and m["rating"] == 5 and m["source"] == "artstation"


def test_bad_packs_rejected(client):
    assert client.post("/api/packs/inspect", files={"file": ("x.refis", b"not a zip")}).status_code == 400
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("hello.txt", "x")
    assert client.post("/api/packs/inspect", files={"file": ("x.refis", buf.getvalue())}).status_code == 400
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("refis-pack.json", json.dumps({"format": 99, "items": []}))
    r = client.post("/api/packs/inspect", files={"file": ("x.refis", buf.getvalue())})
    assert r.status_code == 400 and "новой версии" in r.json()["detail"]
    assert client.post("/api/packs/import", json={"token": "../../etc", "folder_id": 1}).status_code == 404
    assert client.post("/api/packs/reveal", json={"path": "/etc/passwd"}).status_code == 400


def test_save_frame_from_video(client):
    vid = make_video(TMP / "pack-video" / "урок_торс.webm")
    before = client.get("/api/status").json()["total"]
    folder = client.post("/api/folders", json={"path": str(vid.parent), "kind": "tutorial"}).json()
    wait_scan(client, before + 1)
    v = listing(client, folder["id"])["урок_торс"]
    client.patch(f"/api/media/{v['id']}", json={"tags": ["торс"]})
    r = client.post(f"/api/media/{v['id']}/frame", data={"t": "83.4"},
                    files={"file": ("frame.jpg", jpeg_bytes("gray", (320, 240)), "image/jpeg")}).json()
    m = client.get(f"/api/media/{r['id']}").json()
    assert m["kind"] == "ref" and set(m["tags"]) == {"торс", "кадр"} and m["source"] == "урок_торс · 1:23.4"
    assert r["path"].replace("\\", "/").endswith("Кадры/урок_торс/урок_торс 01-23.4.jpg")
    bad = client.post(f"/api/media/{v['id']}/frame", files={"file": ("f.jpg", b"<svg/>", "image/jpeg")})
    assert bad.status_code == 400
    assert client.post(f"/api/media/{r['id']}/frame", files={"file": ("f.jpg", jpeg_bytes(), "image/jpeg")}).status_code == 404


def test_export_and_import_whole_folder(client):
    root = TMP / "Мои арты-src"
    for rel, color in (("Руки/a.jpg", "red"), ("Руки/Мужские/b.jpg", "green"), ("c.jpg", "blue")):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (120, 90), color).save(root / rel)
    before = client.get("/api/status").json()["total"]
    f = client.post("/api/folders", json={"path": str(root), "kind": "own"}).json()
    wait_scan(client, before + 3)
    est = client.post("/api/packs/estimate", json={"folder_id": f["id"], "sub": "Руки"}).json()
    assert est["count"] == 2
    from refis import packs
    r = packs.build_pack(packs.ExportIn(name="Мои арты", folder_id=f["id"]), TMP / "folder.refis")
    assert r["count"] == 3
    with zipfile.ZipFile(TMP / "folder.refis") as z:
        m = json.loads(z.read("refis-pack.json"))
        assert m["folder"] == {"name": "Мои арты-src", "kind": "own"}
        assert sorted(i["dir"] for i in m["items"]) == ["", "Руки", "Руки/Мужские"]
        assert "files/Руки/Мужские/b.jpg" in z.namelist()

    client.delete(f"/api/folders/{f['id']}")  # как будто это другой компьютер: в библиотеке этих файлов нет
    with open(TMP / "folder.refis", "rb") as fh:
        info = client.post("/api/packs/inspect", files={"file": ("folder.refis", fh)}).json()
    assert info["folder"] == {"name": "Мои арты-src", "kind": "own"} and info["dirs"] == 2 and info["own"] == 3
    res = client.post("/api/packs/import", json={"token": info["token"], "new_parent": str(TMP / "pc2"),
                                                  "new_name": "Мои арты", "new_kind": "own", "own_as_ref": False}).json()
    new_root = TMP / "pc2" / "Мои арты"
    assert sorted(p.relative_to(new_root).as_posix() for p in new_root.rglob("*.jpg")) == \
        sorted(["Руки/Мужские/b.jpg", "Руки/a.jpg", "c.jpg"])
    folder = next(x for x in client.get("/api/folders").json() if x["id"] == res["folder_id"])
    assert folder["kind"] == "own" and folder["path"] == str(new_root) and folder["count"] == 3
    assert {client.get(f"/api/media/{i}").json()["kind"] for i in res["added"]} == {"own"}
    tree = {d["sub"]: d["count"] for d in client.get(f"/api/folders/{res['folder_id']}/tree").json()}
    assert tree == {"Руки": 2, "Руки/Мужские": 1}
