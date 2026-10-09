"""Сетевые запросы с корректными сертификатами (в том числе в собранном .exe)."""
import ssl
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def http_get(url: str, timeout: int = 25, headers: dict | None = None) -> tuple[bytes, str, str]:
    """Скачивает URL. Возвращает (данные, content-type, итоговый адрес после редиректов)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as r:
        return r.read(), r.headers.get("Content-Type", ""), r.geturl()
