"""Разделы: свои разделы, переименование, удаление, экспорт и импорт целого раздела."""
import json
import zipfile

from PIL import Image

from conftest import TMP, wait_scan

state = {}


def sections(client):
    return {s["key"]: s for s in client.get("/api/sections").json()}


def test_builtin_sections(client):
    s = sections(client)
    assert list(s)[:4] == ["ref", "own", "tutorial", "other"]
    assert not s["ref"]["deletable"] and not s["own"]["deletable"] and s["tutorial"]["deletable"]
    assert s["ref"]["color"].startswith("#") and s["ref"]["count"] > 0


def test_create_rename_and_use_section(client):
    r = client.post("/api/sections", json={"name": "  Анатомия  "}).json()
    key = r["key"]
    assert r["name"] == "Анатомия" and r["color"].startswith("#") and r["deletable"] and not r["builtin"]
    assert client.post("/api/sections", json={"name": "анатомия"}).status_code == 400
    assert client.post("/api/sections", json={"name": " "}).status_code == 400

    root = TMP / "sec-lib"
    for rel, color in (("Торс/a.jpg", "teal"), ("Торс/b.jpg", "navy"), ("c.jpg", "olive")):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (100, 140), color).save(root / rel)
    before = client.get("/api/status").json()["total"]
    f = client.post("/api/folders", json={"path": str(root), "kind": key}).json()
    wait_scan(client, before + 3)
    ids = [m["id"] for m in client.get("/api/media", params={"kind": key}).json()["items"]]
    assert len(ids) == 3 and sections(client)[key]["count"] == 3
    one = client.get("/api/media", params={"folder": f["id"]}).json()["items"][0]["id"]
    client.post("/api/media/bulk", json={"ids": [one], "kind": "ref"})
    assert len(client.get("/api/media", params={"kind": key}).json()["items"]) == 2
    client.post("/api/media/bulk", json={"ids": [one], "kind": key})
    client.patch(f"/api/media/{one}", json={"tags": ["торс"]})

    assert client.patch(f"/api/sections/{key}", json={"name": "Анатомия людей", "color": "#112233"}).json()["color"] == "#112233"
    assert client.patch(f"/api/sections/{key}", json={"color": "red"}).status_code == 400
    assert client.patch(f"/api/sections/{key}", json={"name": "Референсы!"}).status_code == 200
    client.patch(f"/api/sections/{key}", json={"name": "Анатомия"})
    assert client.patch("/api/sections/ref", json={"name": "Рефы"}).json()["name"] == "Рефы"
    assert client.patch("/api/sections/ref", json={"name": ""}).json()["name"] == ""  # стандартное имя
    assert client.patch(f"/api/sections/{key}", json={"name": ""}).status_code == 400
    order = [k for k in sections(client)]
    client.put("/api/sections/order", json={"keys": [key] + [k for k in order if k != key]})
    assert list(sections(client))[0] == key
    client.put("/api/sections/order", json={"keys": order})
    state.update(key=key, folder=f["id"], root=root)


def test_core_sections_cannot_be_deleted(client):
    assert client.post("/api/sections/ref/delete", json={"move_to": "other"}).status_code == 400
    assert client.post("/api/sections/own/delete", json={"move_to": "ref"}).status_code == 400
    assert client.post(f"/api/sections/{state['key']}/delete", json={"move_to": state["key"]}).status_code == 400
    assert client.post(f"/api/sections/{state['key']}/delete", json={"move_to": "nope"}).status_code == 400


def test_export_section_and_import_on_another_pc(client):
    from refis import packs
    key = state["key"]
    assert client.post("/api/packs/estimate", json={"kind": key}).json()["count"] == 3
    out = TMP / "section.refis"
    packs.build_pack(packs.ExportIn(name="Анатомия", kind=key), out)
    with zipfile.ZipFile(out) as z:
        m = json.loads(z.read("refis-pack.json"))
    assert m["section"] == key and {"key": key, "name": "Анатомия", "color": "#112233"} in m["sections"]
    assert sorted(i["dir"] for i in m["items"]) == ["sec-lib", "sec-lib/Торс", "sec-lib/Торс"]

    # «другой компьютер»: ни папки, ни раздела нет
    client.delete(f"/api/folders/{state['folder']}")
    r = client.post(f"/api/sections/{key}/delete", json={"move_to": "ref"}).json()
    assert r["ok"] and key not in sections(client)
    with open(out, "rb") as fh:
        info = client.post("/api/packs/inspect", files={"file": ("s.refis", fh)}).json()
    assert info["section"] == {"name": "Анатомия", "color": "#112233"}
    res = client.post("/api/packs/import", json={"token": info["token"], "new_parent": str(TMP / "pc3"),
                                                  "new_name": "Анатомия", "new_kind": ""}).json()
    new = [s for s in sections(client).values() if s["name"] == "Анатомия"]
    assert len(new) == 1 and new[0]["color"] == "#112233" and new[0]["count"] == 3
    folder = next(f for f in client.get("/api/folders").json() if f["id"] == res["folder_id"])
    assert folder["kind"] == new[0]["key"]
    assert (TMP / "pc3" / "Анатомия" / "sec-lib" / "Торс" / "a.jpg").exists()
    assert any("торс" in client.get(f"/api/media/{i}").json()["tags"] for i in res["added"])

    # второй раз тот же раздел не создаётся — находится по имени
    client.delete(f"/api/folders/{res['folder_id']}")
    with open(out, "rb") as fh:
        info = client.post("/api/packs/inspect", files={"file": ("s.refis", fh)}).json()
    client.post("/api/packs/import", json={"token": info["token"], "new_parent": str(TMP / "pc4"), "new_name": "A", "new_kind": ""})
    assert len([s for s in sections(client).values() if s["name"] == "Анатомия"]) == 1
    state["key2"] = new[0]["key"]


def test_delete_section_with_files_to_trash(client, monkeypatch):
    import shutil

    from refis import media
    gone = TMP / "sec-bin"
    gone.mkdir()
    monkeypatch.setattr(media, "trash_file", lambda p: shutil.move(p, gone))
    key = state["key2"]
    n = sections(client)[key]["count"]
    r = client.post(f"/api/sections/{key}/delete", json={"move_to": "ref", "trash": True}).json()
    assert r["ok"] and r["failed"] == [] and len(list(gone.iterdir())) == n
    assert key not in sections(client)
    assert all(m["kind"] != key for m in client.get("/api/media", params={"limit": 2000}).json()["items"])


def test_deleted_builtin_can_be_restored_by_pack(client):
    assert client.post("/api/sections/other/delete", json={"move_to": "ref"}).json()["ok"]
    assert "other" not in sections(client)
    assert client.post("/api/folders", json={"path": str(TMP), "kind": "other"}).status_code == 400
    from refis import organize
    assert organize.guess_kind("Уроки рисования") == "tutorial"
    client.post("/api/sections/tutorial/delete", json={"move_to": "ref"})
    assert organize.guess_kind("Уроки рисования") == "ref"
