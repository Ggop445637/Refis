"""Профиль: статистика практики, темы, рост библиотеки, свои работы, достижения."""
import datetime as dt
import time
from collections import defaultdict

from fastapi import APIRouter

from . import db

router = APIRouter(prefix="/api")
DAY = 86400


def _streaks(days: set[dt.date]) -> tuple[int, int]:
    """(текущая серия, лучшая серия) по дням практики."""
    if not days:
        return 0, 0
    best = run = 0
    prev = None
    for d in sorted(days):
        run = run + 1 if prev and (d - prev).days == 1 else 1
        best = max(best, run)
        prev = d
    today = dt.date.today()
    cur, d = 0, today if today in days else today - dt.timedelta(days=1)
    while d in days:
        cur += 1
        d -= dt.timedelta(days=1)
    return cur, best


@router.get("/profile")
def profile():
    conn = db.connect()
    logs = [dict(r) for r in conn.execute("SELECT ts, kind, count, seconds, tag, ctype, prompt FROM practice_log ORDER BY ts")]
    days = {dt.date.fromtimestamp(r["ts"]) for r in logs}
    cur, best = _streaks(days)
    seconds = sum(r["seconds"] for r in logs)
    sketches = sum(r["count"] for r in logs if r["kind"] == "gesture")
    challenges = sum(1 for r in logs if r["kind"] == "challenge")

    # минуты по неделям (последние 26 недель, неделя с понедельника)
    today = dt.date.today()
    monday = today - dt.timedelta(days=today.weekday())
    weeks = [{"start": (monday - dt.timedelta(weeks=i)).isoformat(), "minutes": 0, "sessions": 0} for i in range(25, -1, -1)]
    index = {w["start"]: w for w in weeks}
    for r in logs:
        d = dt.date.fromtimestamp(r["ts"])
        w = index.get((d - dt.timedelta(days=d.weekday())).isoformat())
        if w:
            w["minutes"] += r["seconds"] / 60
            w["sessions"] += 1
    for w in weeks:
        w["minutes"] = round(w["minutes"])

    # темы: сколько практиковались и какие давно не трогали
    by_tag: dict = defaultdict(lambda: {"minutes": 0.0, "sessions": 0, "last": 0})
    for r in logs:
        if r["tag"]:
            t = by_tag[r["tag"]]
            t["minutes"] += r["seconds"] / 60
            t["sessions"] += 1
            t["last"] = max(t["last"], r["ts"])
    topics = sorted(({"tag": k, "minutes": round(v["minutes"]), "sessions": v["sessions"], "last": v["last"]}
                     for k, v in by_tag.items()), key=lambda t: -t["minutes"])[:10]
    lib_topics = [dict(r) for r in conn.execute(
        "SELECT t.name tag, COUNT(*) count FROM tags t JOIN media_tags mt ON mt.tag_id = t.id JOIN media m ON m.id = mt.media_id"
        " WHERE m.missing = 0 AND m.type = 'image' GROUP BY t.id HAVING count >= 3 ORDER BY count DESC")]
    month_ago = time.time() - 30 * DAY
    neglected = [t for t in lib_topics if by_tag.get(t["tag"], {}).get("last", 0) < month_ago][:12]

    # библиотека по месяцам (последние 12) и свои работы
    months = []
    for i in range(11, -1, -1):
        y, m = today.year, today.month - i
        while m <= 0:
            y, m = y - 1, m + 12
        months.append({"month": f"{y}-{m:02d}", "added": 0})
    mindex = {x["month"]: x for x in months}
    for r in conn.execute("SELECT added_at FROM media WHERE missing = 0 AND added_at > ?", (time.time() - 370 * DAY,)):
        x = mindex.get(dt.date.fromtimestamp(r["added_at"]).strftime("%Y-%m"))
        if x:
            x["added"] += 1
    own = [dict(r) for r in conn.execute(
        "SELECT id, name, ext, type, width, height, thumb_state, mtime FROM media"
        " WHERE missing = 0 AND kind = 'own' AND type = 'image' ORDER BY mtime DESC LIMIT 120")]

    lib = dict(conn.execute(
        "SELECT COUNT(*) total, COALESCE(SUM(kind = 'own'), 0) own, COALESCE(SUM(favorite), 0) favorites,"
        " COALESCE(SUM(EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = media.id)), 0) tagged"
        " FROM media WHERE missing = 0").fetchone())
    pins_saved = conn.execute("SELECT COUNT(*) FROM pins WHERE status = 'saved'").fetchone()[0]
    boards = conn.execute("SELECT COUNT(*) FROM boards").fetchone()[0]
    redraws = sum(1 for r in logs if r["ctype"] == "redraw")
    hours = seconds / 3600
    tagged_share = lib["tagged"] / lib["total"] if lib["total"] else 0

    def ach(aid, icon, title, desc, value, goal):
        return {"id": aid, "icon": icon, "title": title, "desc": desc, "value": round(value, 1), "goal": goal,
                "progress": min(1, value / goal) if goal else 0, "done": value >= goal}

    achievements = [
        ach("first", "🌱", "Первый шаг", "Провести первую сессию практики", len(logs), 1),
        ach("sketch100", "✏️", "Сотня набросков", "Сделать 100 набросков на таймере", sketches, 100),
        ach("sketch1000", "🖋️", "Тысяча набросков", "Сделать 1000 набросков", sketches, 1000),
        ach("streak7", "🔥", "Неделя подряд", "Практиковаться 7 дней подряд", best, 7),
        ach("streak30", "🌋", "Месяц подряд", "Практиковаться 30 дней подряд", best, 30),
        ach("hours10", "⏱️", "10 часов за листом", "Суммарно 10 часов практики", hours, 10),
        ach("hours100", "🏔️", "100 часов", "Суммарно 100 часов практики", hours, 100),
        ach("topics10", "🧭", "Исследователь", "Практиковаться по 10 разным темам", len(by_tag), 10),
        ach("challenge25", "🎯", "Охотник за заданиями", "Выполнить 25 заданий «Нарисуй это»", challenges, 25),
        ach("redraw", "🔁", "Было — стало", "Перерисовать свою старую работу", redraws, 1),
        ach("order", "🗂️", "Порядок", "Разметить тегами 90% библиотеки", tagged_share * 100, 90),
        ach("collector", "🖼️", "Коллекционер", "Собрать 1000 файлов в библиотеке", lib["total"], 1000),
        ach("boards", "📋", "Мудборд", "Создать 3 доски референсов", boards, 3),
        ach("pins", "📌", "Охотник за пинами", "Сохранить 50 пинов из Pinterest", pins_saved, 50),
    ]
    recent = [{"ts": r["ts"], "kind": r["kind"], "minutes": round(r["seconds"] / 60), "count": r["count"],
               "tag": r["tag"], "prompt": r["prompt"]} for r in reversed(logs[-12:])]
    return {
        "totals": {"minutes": round(seconds / 60), "sessions": len(logs), "sketches": sketches, "challenges": challenges,
                   "days": len(days), "streak": cur, "best_streak": best,
                   "since": min((r["ts"] for r in logs), default=None)},
        "weeks": weeks, "topics": topics, "neglected": neglected, "months": months,
        "library": {**lib, "tagged_share": tagged_share, "pins_saved": pins_saved, "boards": boards},
        "own": own, "achievements": achievements, "recent": recent,
    }
