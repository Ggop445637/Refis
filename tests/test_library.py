"""Организация библиотеки, задания из своих тем, Pinterest (с подменённой сетью).

Тесты идут по порядку и опираются на общее состояние — как пользователь в приложении.
"""
from conftest import TMP, make_library, wait_scan

LIB = TMP / "lib"
state = {}


def test_add_folders_and_scan(client):
    make_library(LIB)
    r = client.post("/api/folders", json={"path": str(LIB / "Референсы"), "kind": "ref", "auto_tags": False})
    assert r.status_code == 200, r.text
    assert client.post("/api/folders", json={"path": str(LIB / "Мои арты"), "kind": "own"}).status_code == 200
    wait_scan(client, 13)
    h = client.get("/api/organize/health").json()
    assert h["total"] == 13 and h["untagged"] == 13 and not h["ready"]


def test_overlapping_folder_rejected(client):
    r = client.post("/api/folders", json={"path": str(LIB / "Референсы" / "Руки")})
    assert r.status_code == 400


def test_no_invented_challenges_without_tags(client):
    # без тегов — только то, что реально есть (старая своя работа), никаких выдуманных тем
    assert client.get("/api/challenge").json()["ctype"] in ("none", "redraw")


def test_tag_suggestions_from_names_and_folders(client):
    sug = {s["tag"]: s for s in client.get("/api/organize/tag-suggestions").json()}
    state["sug"] = sug
    assert sug["dragon"]["count"] == 4  # вместе с my_dragon_2023
    assert "руки" in sug and "лица" in sug
    assert not {"img", "dsc", "fbeac"} & set(sug)


def test_triage_suggests_folder_neighbours(client):
    sug = state["sug"]
    for t in ("dragon", "hand"):
        client.post("/api/organize/apply", json={"tag": t, "ids": sug[t]["ids"]})
    queue = client.get("/api/organize/triage").json()
    img = next(t for t in queue if t["name"] == "IMG_2041")
    s = client.get(f"/api/organize/suggest/{img['id']}").json()
    assert s[0] == {"tag": "hand", "why": "в этой папке"}


def test_apply_rest_and_health(client):
    sug = state["sug"]
    for t in ("руки", "лица", "portrait"):
        client.post("/api/organize/apply", json={"tag": t, "ids": sug[t]["ids"]})
    h = client.get("/api/organize/health").json()
    assert h["untagged"] <= 1 and h["ready"]
    assert len(client.get("/api/organize/triage").json()) == h["untagged"]


def test_daily_reference_from_own_topics(client):
    t = client.get("/api/today").json()
    tags = t["media"]["tags"]
    assert t["tag"] and any(x == t["tag"] or x.startswith(t["tag"] + "/") for x in tags)


def test_challenges_built_from_library(client):
    kinds = set()
    for n in range(30):
        ch = client.get(f"/api/challenge?n={n}").json()
        kinds.add(ch["ctype"])
        if ch["ctype"] == "tag":
            assert ch["tag"] in client.get(f"/api/media/{ch['images'][0]['id']}").json()["tags"]
    assert {"tag", "redraw"} <= kinds
    assert client.get("/api/challenge?n=3").json() == client.get("/api/challenge?n=3").json()


def test_practiced_topic_shown_less(client):
    for _ in range(5):
        client.post("/api/practice", json={"kind": "challenge", "count": 1, "seconds": 600, "tag": "dragon", "ctype": "tag"})
    picked = [client.get(f"/api/today?n={n}").json()["tag"] for n in range(40)]
    assert picked.count("dragon") < picked.count("руки") + picked.count("лица")


def test_upload_file(client):
    from conftest import jpeg_bytes
    fid = client.get("/api/folders").json()[0]["id"]
    r = client.post("/api/upload", data={"folder_id": fid, "tags": "новое, свет"},
                    files={"files": ("new ref.jpg", jpeg_bytes(), "image/jpeg")}).json()
    m = client.get(f"/api/media/{r['added'][0]}").json()
    assert set(m["tags"]) == {"новое", "свет"} and "_Входящие" in m["path"]


# ---------------------------------------------------------------- Pinterest

def test_pinterest_links():
    from refis import pinterest
    src = pinterest.parse_source("https://ru.pinterest.com/artist/anatomy-refs/")
    assert src["url"] == "https://www.pinterest.com/artist/anatomy-refs.rss" and src["tag"] == "anatomy refs"
    assert pinterest.parse_source("artist")["url"] == "https://www.pinterest.com/artist/feed.rss"


def test_pinterest_bad_links_rejected(client):
    for bad in ("https://example.com/x", "https://www.pinterest.com/pin/123/"):
        assert client.post("/api/pinterest/sources", json={"url": bad}).status_code == 400


def test_pinterest_sync_and_save(client, fake_net):
    r = client.post("/api/pinterest/sources", json={"url": "pinterest.com/artist/anatomy-refs"}).json()
    assert r["added"] == 2
    src = client.get("/api/pinterest/sources").json()[0]
    assert src["title"] == "Anatomy refs" and src["new"] == 2
    assert client.post(f"/api/pinterest/sources/{src['id']}/sync").json()["added"] == 0
    pins = client.get("/api/pinterest/pins").json()["items"]
    assert {p["title"] for p in pins} == {"Torso study", "Hands gesture"}
    img = client.get(f"/api/pinterest/pins/{pins[0]['id']}/img")
    assert img.status_code == 200 and img.headers["content-type"] == "image/jpeg"
    assert "pin" in {client.get(f"/api/challenge?n={n}").json()["ctype"] for n in range(40)}
    fid = client.get("/api/folders").json()[0]["id"]
    res = client.post("/api/pinterest/pins/save", json={"ids": [p["id"] for p in pins], "folder_id": fid}).json()
    assert len(res["saved"]) == 2 and not res["errors"]
    assert any("/736x/aa" in u for u in fake_net.calls)  # оригинал недоступен → 736px
    m = client.get(f"/api/media/{res['saved'][0]}").json()
    assert {"anatomy refs", "pinterest"} <= set(m["tags"]) and "Pinterest" in m["path"]
    assert m["source"].startswith("https://www.pinterest.com/pin/")
    assert client.get("/api/pinterest/pins").json()["total"] == 0


def test_discover_runs(client):
    assert client.get("/api/organize/discover").status_code == 200
