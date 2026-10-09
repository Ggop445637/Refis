"""Локальный сервер не должен слушаться чужих сайтов."""
from fastapi.testclient import TestClient


def raw(host="http://127.0.0.1"):
    from refis.server import app
    return TestClient(app, base_url=host)


def test_session_token_readable_by_ui(client):
    r = client.get("/api/session")
    assert r.status_code == 200 and len(r.json()["token"]) >= 32


def test_post_without_token_rejected(client):
    r = raw().post("/api/scan")
    assert r.status_code == 403


def test_post_with_wrong_token_rejected(client):
    r = raw().post("/api/scan", headers={"X-Refis-Token": "nope"})
    assert r.status_code == 403


def test_multipart_upload_without_token_rejected(client):
    # обычная HTML-форма с чужого сайта не должна записывать файлы в библиотеку
    r = raw().post("/api/upload", data={"folder_id": "1"}, files={"files": ("x.jpg", b"123", "image/jpeg")})
    assert r.status_code == 403


def test_foreign_host_rejected_dns_rebinding(client):
    r = raw("http://evil.example").get("/api/session")
    assert r.status_code == 403


def test_foreign_origin_rejected(client):
    r = client.get("/api/folders", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.get("/api/folders", headers={"Origin": "null"})
    assert r.status_code == 403


def test_local_origin_allowed(client):
    r = client.get("/api/folders", headers={"Origin": "http://127.0.0.1:5000"})
    assert r.status_code == 200
    r = client.post("/api/scan", headers={"Origin": "http://localhost:5000"})
    assert r.status_code == 200


def test_get_static_without_token(client):
    assert raw().get("/").status_code == 200
    assert raw().get("/js/main.js").headers["content-type"].startswith("text/javascript")


def test_api_docs_disabled(client):
    assert raw().get("/docs").status_code == 404
