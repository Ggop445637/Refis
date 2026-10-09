"""Перевод серверных сообщений: тексты заданий, причины выбора, достижения, ошибки.

tr("Тема дня — #{tag}", tag=x) — ключ всегда русский, подстановки по имени.
"""
_lang = None


def lang() -> str:
    global _lang
    if _lang is None:
        try:
            from . import system
            _lang = system.get("lang")
        except Exception:  # база ещё не открыта
            return "ru"
    return _lang


def reset() -> None:
    """Вызывается при смене настроек."""
    global _lang
    _lang = None


def tr(text: str, **kw) -> str:
    s = EN.get(text, text) if lang() == "en" else text
    return s.format(**kw) if kw else s


EN = {
    # подсказки разметки
    "в этой папке": "in this folder", "по имени файла": "from file name", "у дубликата": "on a duplicate",
    "популярный": "popular", "новый, из имени": "new, from name",
    # референс дня и задания
    "Тема дня — #{tag}: по ней вы давно не практиковались": "Topic of the day — #{tag}: you haven't practiced it in a while",
    "Тема дня — #{tag}": "Topic of the day — #{tag}",
    "Пока случайно: разметьте файлы тегами, и подбор станет точнее": "Random for now: tag your files and picks will get smarter",
    "Добавьте теги к файлам — задания строятся из ваших тем и референсов.": "Tag your files — challenges are built from your own topics and references.",
    "Серия набросков: #{tag}": "Sketch series: #{tag}",
    "{n} референсов из темы «{tag}» по {per} секунд — разогрев руки и глаза.": "{n} references from “{tag}”, {per} seconds each — a warm-up for hand and eye.",
    "не детализируй, лови движение и пропорции": "skip details, catch movement and proportions",
    "Мастер-штудия": "Master study",
    "Скопируй как можно точнее свой любимый референс «{name}».": "Copy your favorite reference “{name}” as accurately as you can.",
    "сначала пропорции и большие тени, детали — в конце": "proportions and big shadows first, details last",
    "{n} мес. назад": "{n} months ago", "{n} г. назад": "{n} years ago",
    "Перерисуй свою работу": "Redraw your work",
    "«{name}» — нарисована {when}. Нарисуй заново и сравни, как ты вырос(ла).": "“{name}” — drawn {when}. Draw it again and see how far you've come.",
    "не копируй старую — нарисуй с нуля, глядя на неё": "don't copy the old one — draw from scratch, looking at it",
    "Свежий пин": "Fresh pin",
    "Новый референс с доски «{board}»": "A new reference from the board “{board}”",
    "Нарисуй: #{tag}": "Draw: #{tag}",
    "Тема из вашей библиотеки ({n} референсов)": "A topic from your library ({n} references)",
    "; давно не практиковались": "; not practiced in a while",
    "только 3 тона": "only 3 values", "без ластика": "no eraser", "одной непрерывной линией": "one continuous line",
    "сначала силуэт, потом детали": "silhouette first, then details", "только крупные формы": "big shapes only",
    "без контурных линий": "no outlines", "только прямые линии": "straight lines only", "максимум 20 линий": "20 lines max",
    "только светотень, без линий": "light and shadow only, no lines", "в двух цветах": "two colors only", "широкой кистью": "with a broad brush",
    "начни с самых тёмных пятен": "start with the darkest shapes", "сначала простые объёмы: шар, куб, цилиндр": "simple forms first: sphere, cube, cylinder",
    "не отрывая взгляда от референса": "without looking away from the reference", "в квадратном формате": "in a square format",
    # достижения
    "Первый шаг": "First step", "Провести первую сессию практики": "Complete your first practice session",
    "Сотня набросков": "A hundred sketches", "Сделать 100 набросков на таймере": "Make 100 timed sketches",
    "Тысяча набросков": "A thousand sketches", "Сделать 1000 набросков": "Make 1000 sketches",
    "Неделя подряд": "A week in a row", "Практиковаться 7 дней подряд": "Practice 7 days in a row",
    "Месяц подряд": "A month in a row", "Практиковаться 30 дней подряд": "Practice 30 days in a row",
    "10 часов за листом": "10 hours of drawing", "Суммарно 10 часов практики": "10 hours of practice in total",
    "100 часов": "100 hours", "Суммарно 100 часов практики": "100 hours of practice in total",
    "Исследователь": "Explorer", "Практиковаться по 10 разным темам": "Practice 10 different topics",
    "Охотник за заданиями": "Challenge hunter", "Выполнить 25 заданий «Нарисуй это»": "Complete 25 “Draw this” challenges",
    "Было — стало": "Then and now", "Перерисовать свою старую работу": "Redraw one of your old works",
    "Порядок": "Organized", "Разметить тегами 90% библиотеки": "Tag 90% of your library",
    "Коллекционер": "Collector", "Собрать 1000 файлов в библиотеке": "Collect 1000 files in your library",
    "Мудборд": "Moodboard", "Создать 3 доски референсов": "Create 3 reference boards",
    "Охотник за пинами": "Pin hunter", "Сохранить 50 пинов из Pinterest": "Save 50 pins from Pinterest",
    # Pinterest
    "Рекомендации": "Recommendations", "Пустая ссылка": "Empty link",
    "Не похоже на ссылку Pinterest или имя пользователя": "This doesn't look like a Pinterest link or username",
    "Это не ссылка на Pinterest": "This is not a Pinterest link",
    "Нужна ссылка на профиль или доску, например pinterest.com/имя/доска": "A profile or board link is needed, e.g. pinterest.com/name/board",
    "Pinterest вернул не RSS-ленту (доска приватная или ссылка неверна)": "Pinterest didn't return an RSS feed (the board is private or the link is wrong)",
    "Не удалось загрузить ленту: {e}": "Couldn't load the feed: {e}", "Не удалось скачать картинку: {e}": "Couldn't download the image: {e}",
    "Папка не найдена": "Folder not found", "Не удалось распознать пин": "Couldn't recognize the pin",
    "Сначала добавьте папку библиотеки в Refis": "Add a library folder in Refis first", "Не сохранено": "Not saved",
    "Не удалось открыть ссылку: {e}": "Couldn't open the link: {e}", "Эта доска уже подключена": "This board is already connected",
    "Нет связи с Pinterest: {e}": "No connection to Pinterest: {e}", "Профиль {user}": "Profile {user}",
    "Сохранённые из ленты": "Saved from feed",
    # безопасность и ошибки API
    "Доступ только с этого компьютера": "Access is only allowed from this computer",
    "Запрос с чужого сайта отклонён": "Request from another website was rejected",
    "Нет токена сессии — перезагрузите окно Refis": "No session token — reload the Refis window",
    "Файл не найден в каталоге": "File not found in catalog", "Папка не найдена: {path}": "Folder not found: {path}",
    "Неизвестный тип": "Unknown type", "Пересекается с уже добавленной папкой: {path}": "Overlaps an already added folder: {path}",
    "Файл не найден на диске": "File not found on disk", "Пустое имя": "Empty name", "Доска не найдена": "Board not found",
    "Поиск": "Search", "Новая доска": "New board", "Доска": "Board", "доска": "board", "_Входящие": "_Inbox",
    "Неизвестная настройка: {k}": "Unknown setting: {k}", "Неверное значение для {k}": "Invalid value for {k}",
    "Можно открывать только веб-ссылки": "Only web links can be opened",
    "Это не резервная копия Refis (нет refis.db)": "This is not a Refis backup (no refis.db)",
    "Файл базы в копии повреждён": "The database file in the backup is damaged",
    "Недопустимые пути в архиве": "The archive contains invalid paths", "Файл не является zip-архивом": "The file is not a zip archive",
}
