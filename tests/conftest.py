"""Общие настройки тестов: отдельная папка данных, клиент API, подменённый Pinterest."""
import io
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="refis-tests-"))
os.environ["REFIS_DATA"] = str(TMP / "data")  # до импорта refis — иначе база окажется в настоящей папке
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402
from PIL import Image  # noqa: E402

RSS = b"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Anatomy refs</title><link>https://www.pinterest.com/artist/anatomy-refs/</link>
<item><title>Torso study</title><link>https://www.pinterest.com/pin/111/</link>
<description>&lt;a href="/pin/111/"&gt;&lt;img src="https://i.pinimg.com/236x/aa/bb/cc/aabbcc.jpg"&gt;&lt;/a&gt;Torso study</description>
<pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><guid>https://www.pinterest.com/pin/111/</guid></item>
<item><title></title><link>https://www.pinterest.com/pin/222/</link>
<description>&lt;img src="https://i.pinimg.com/236x/dd/ee/ff/ddeeff.jpg"&gt;Hands gesture</description>
<guid>https://www.pinterest.com/pin/222/</guid></item>
</channel></rss>"""


def jpeg_bytes(color="orange", size=(600, 800)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "JPEG")
    return b.getvalue()


class FakePinterest:
    """Подмена сети: RSS-лента и картинки без обращения к pinterest.com."""

    def __init__(self):
        self.calls = []

    def __call__(self, url, timeout=25):
        self.calls.append(url)
        if url.endswith(".rss"):
            return RSS, "application/rss+xml", url
        if "/originals/aa" in url:
            raise OSError("403 originals")
        if "pinimg" in url:
            return jpeg_bytes(), "image/jpeg", url
        raise OSError("unexpected " + url)


@pytest.fixture(scope="session")
def fake_net():
    from refis import pinterest
    fake = FakePinterest()
    pinterest.http_get = fake
    return fake


@pytest.fixture(scope="session")
def client(fake_net):
    from fastapi.testclient import TestClient

    from refis import security
    from refis.server import app
    with TestClient(app, base_url="http://127.0.0.1") as c:
        c.headers["X-Refis-Token"] = security.TOKEN
        yield c


def make_library(root: Path) -> Path:
    """Небольшая библиотека с говорящими и «мусорными» именами файлов."""
    import time
    plan = {
        "Референсы/Руки": ["hand_pose_01", "hand_pose_02", "hands closeup", "IMG_2041"],
        "Референсы/Лица": ["portrait_light_01", "portrait_light_02", "face side", "DSC00012"],
        "Референсы": ["dragon_wing", "dragon_head", "dragon_scale", "a7f3bc9e8d"],
    }
    for sub, names in plan.items():
        (root / sub).mkdir(parents=True, exist_ok=True)
        for i, n in enumerate(names):
            Image.new("RGB", (300 + i * 10, 400), (i * 40, 80, 120)).save(root / sub / f"{n}.jpg")
    (root / "Мои арты").mkdir(parents=True, exist_ok=True)
    old = root / "Мои арты" / "my_dragon_2023.png"
    Image.new("RGB", (500, 500), "purple").save(old)
    os.utime(old, (time.time() - 200 * 86400, time.time() - 200 * 86400))
    return root


def wait_scan(client, total, timeout=15):
    import time
    from refis import media
    end = time.time() + timeout
    while time.time() < end:
        if not media.scan_status["running"] and client.get("/api/status").json()["total"] >= total:
            return
        time.sleep(0.1)
    raise AssertionError("сканирование не закончилось")


def make_video(path: Path, seconds: int = 3) -> Path:
    """Короткое webm-видео (его играет и Chromium в UI-тестах)."""
    import subprocess

    import imageio_ffmpeg
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-f", "lavfi",
                    "-i", f"testsrc=duration={seconds}:size=320x240:rate=10", "-c:v", "libvpx", "-b:v", "200k", str(path)],
                   check=True)
    return path
