"""Свои папки: создание, подпапки, дерево и перемещение файлов между папками."""
from PIL import Image

from conftest import TMP, wait_scan

state = {}


def ids_in(client, folder, sub=""):
    return {m["name"]: m["id"] for m in client.get("/api/media", params={"folder": folder, "sub": sub}).json()["items"]}


def test_create_library_folder_and_subfolders(client):
    r = client.post("/api/folders/create", json={"parent": str(TMP / "made"), "name": "Мои скетчи", "kind": "ref"}).json()
    assert (TMP / "made" / "Мои скетчи").is_dir()
    assert any(f["id"] == r["id"] for f in client.get("/api/folders").json())
    assert client.post("/api/folders/create", json={"parent": str(TMP / "made"), "name": "Мои скетчи"}).status_code == 400
    assert client.post(f"/api/folders/{r['id']}/mkdir", json={"sub": "Руки/Мужские"}).json() == {"sub": "Руки/Мужские"}
    assert client.post(f"/api/folders/{r['id']}/mkdir", json={"sub": "../../вне"}).json() == {"sub": "вне"}
    assert (TMP / "made" / "Мои скетчи" / "вне").is_dir() and not (TMP / "вне").exists()
    tree = {d["sub"]: d for d in client.get(f"/api/folders/{r['id']}/tree").json()}
    assert set(tree) == {"Руки", "Руки/Мужские", "вне"} and tree["Руки/Мужские"]["depth"] == 1
    assert client.post(f"/api/folders/{r['id']}/mkdir", json={"sub": " / "}).status_code == 400
    assert client.get("/api/folders/default-parent").json()["path"]
    slash = client.post("/api/folders/create", json={"parent": str(TMP / "made"), "name": "Руки/Ноги"}).json()
    assert slash["path"] == str(TMP / "made" / "Руки_Ноги")
    client.delete(f"/api/folders/{slash['id']}")
    state["dst"] = r["id"]


def test_move_files_into_subfolder(client):
    src = TMP / "move-src"
    (src / "old").mkdir(parents=True)
    for n in ("кисть", "палец"):
        Image.new("RGB", (100, 100), "red").save(src / f"{n}.jpg")
    Image.new("RGB", (100, 100), "blue").save(src / "old" / "кисть.jpg")
    before = client.get("/api/status").json()["total"]
    f = client.post("/api/folders", json={"path": str(src), "kind": "ref", "auto_tags": False}).json()
    wait_scan(client, before + 3)
    listed = client.get("/api/media", params={"folder": f["id"]}).json()["items"]
    by_name = {m["path"]: m["id"] for m in (client.get(f"/api/media/{i['id']}").json() for i in listed)}
    a, b, c = by_name[str(src / "кисть.jpg")], by_name[str(src / "палец.jpg")], by_name[str(src / "old" / "кисть.jpg")]
    client.patch(f"/api/media/{a}", json={"tags": ["кисти"], "rating": 3})

    dst = state["dst"]
    r = client.post("/api/media/move", json={"ids": [a, b, c, 999999], "folder_id": dst, "sub": "Руки"}).json()
    assert r["ids"] == [a, b, c] and r["failed"] == []
    target = TMP / "made" / "Мои скетчи" / "Руки"
    assert sorted(p.name for p in target.iterdir() if p.is_file()) == ["кисть (1).jpg", "кисть.jpg", "палец.jpg"]
    assert not (src / "кисть.jpg").exists()
    m = client.get(f"/api/media/{a}").json()
    assert m["path"] == str(target / "кисть.jpg") and m["folder_id"] == dst and m["rating"] == 3
    assert set(m["tags"]) == {"кисти", "руки"}  # тег из имени подпапки — у новой папки он включён
    assert client.get(f"/api/media/{c}").json()["name"] == "кисть (1)"
    assert set(ids_in(client, dst, "Руки")) == {"кисть", "кисть (1)", "палец"}
    assert ids_in(client, dst, "Руки/Мужские") == {}
    assert ids_in(client, f["id"]) == {}
    tree = {d["sub"]: d["count"] for d in client.get(f"/api/folders/{dst}/tree").json()}
    assert tree["Руки"] == 3 and tree["Руки/Мужские"] == 0

    # повторное сканирование ничего не теряет и не дублирует
    client.post("/api/scan")
    wait_scan(client, before + 3)
    assert len(ids_in(client, dst, "Руки")) == 3 and client.get(f"/api/media/{a}").json()["missing"] == 0

    # туда, где файл уже лежит, — ничего не делаем; пропавший файл — ошибка, а не падение
    assert client.post("/api/media/move", json={"ids": [b], "folder_id": dst, "sub": "Руки"}).json()["ids"] == []
    (target / "палец.jpg").unlink()
    r = client.post("/api/media/move", json={"ids": [b], "folder_id": dst, "sub": "Руки/Мужские"}).json()
    assert r["ids"] == [] and r["failed"][0]["name"] == "палец.jpg"
    assert client.post("/api/media/move", json={"ids": [a], "folder_id": 999999}).status_code == 404
    client.delete(f"/api/folders/{f['id']}")
