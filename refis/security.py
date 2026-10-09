"""Защита локального сервера от чужих сайтов, открытых в браузере.

Сервер слушает только 127.0.0.1, но браузер пользователя может отправлять на него запросы
с любых сайтов. Поэтому:
- принимаем только запросы, адресованные 127.0.0.1/localhost (защита от DNS rebinding);
- отклоняем запросы с чужим заголовком Origin;
- для изменяющих запросов (POST/PUT/PATCH/DELETE) требуем токен сессии в заголовке
  X-Refis-Token. Токен отдаёт /api/session, а прочитать ответ может только сам интерфейс:
  чужим сайтам браузер не даст увидеть его без CORS, которого у нас нет.
"""
import hmac
import os
import secrets
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

from .i18n import tr

TOKEN = os.environ.get("REFIS_TOKEN") or secrets.token_urlsafe(32)
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _hostname(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("["):  # IPv6 вида [::1]:8000
        return value.split("]")[0] + "]"
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _forbidden(msg: str) -> JSONResponse:
    return JSONResponse({"detail": msg}, status_code=403)


async def guard(request, call_next):
    host = _hostname(request.headers.get("host", ""))
    if host not in LOCAL_HOSTS:
        return _forbidden(tr("Доступ только с этого компьютера"))
    origin = request.headers.get("origin")
    if origin and _hostname(urlsplit(origin).netloc) not in LOCAL_HOSTS:
        return _forbidden(tr("Запрос с чужого сайта отклонён"))
    if request.method not in SAFE_METHODS and request.url.path.startswith("/api/"):
        if not hmac.compare_digest(request.headers.get("x-refis-token", ""), TOKEN):
            return _forbidden(tr("Нет токена сессии — перезагрузите окно Refis"))
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response
