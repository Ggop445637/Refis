// Настройки, резервные копии, обновления и «О программе».
import { $, $$, api, esc, toast, confirmDialog, modal, fmtSize, emit } from "./util.js";

export let settings = {};
let about = null;
let update = null;

const sys = matchMedia("(prefers-color-scheme: light)");

/** Применяет настройки к окну: тема, движение, фон. */
export function applySettings(s) {
  settings = s;
  const theme = s.theme === "system" ? (sys.matches ? "light" : "dark") : s.theme;
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle("reduce-motion", s.motion === "reduced");
  document.body.classList.toggle("perf", !s.ambient);
  document.documentElement.lang = s.lang || "ru";
}
sys.addEventListener("change", () => settings.theme === "system" && applySettings(settings));

export async function loadSettings() {
  applySettings(await api("/settings"));
  return settings;
}

async function save(patch) {
  applySettings(await api("/settings", { method: "PATCH", body: patch }));
}

export const openUrl = (url) => api("/open-url", { method: "POST", body: { url } });

/** Проверка новой версии при запуске — тихо, одно уведомление. */
export async function checkUpdatesOnStart() {
  if (!settings.check_updates) return;
  update = await api("/update").catch(() => null);
  if (update?.newer) {
    $("#settingsBtn")?.insertAdjacentHTML("beforeend", '<i class="update-pill"></i>');
    toast(`Вышла версия ${update.latest}`, { action: "Подробнее", life: 9000, onAction: () => emit("navigate", "settings") });
  }
}

const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, l]) =>
  `<button data-v="${v}" class="${settings[key] === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
const sw = (key) => `<label class="switch"><input type="checkbox" data-key="${key}"${settings[key] ? " checked" : ""}><span></span></label>`;

export async function renderSettings() {
  const root = $("#settings");
  [about] = await Promise.all([api("/about"), loadSettings()]);
  const backups = await api("/backups").catch(() => []);
  root.innerHTML = `
    <header class="rise"><h1>Настройки</h1></header>

    <section class="glass set-card rise" style="--d:1">
      <h2>🎨 Внешний вид</h2>
      <div class="set-row"><div class="lbl"><b>Тема</b><small>Просмотр и тренировка всегда тёмные — так точнее видны тона</small></div>
        ${seg("theme", [["dark", "Тёмная"], ["light", "Светлая"], ["system", "Как в системе"]])}</div>
      <div class="set-row"><div class="lbl"><b>Язык</b></div>${seg("lang", [["ru", "Русский"], ["en", "English"]])}</div>
      <div class="set-row"><div class="lbl"><b>Анимации</b><small>«Минимум» — для слабых компьютеров и если движение отвлекает</small></div>
        ${seg("motion", [["full", "Полные"], ["reduced", "Минимум"]])}</div>
      <div class="set-row"><div class="lbl"><b>Цветной фон</b><small>Медленно плывущие пятна за интерфейсом</small></div>${sw("ambient")}</div>
      <div class="set-row"><div class="lbl"><b>Открывать при запуске</b></div>
        <select data-key="start_page">${[["today", "Сегодня"], ["library", "Библиотека"], ["organize", "Порядок"], ["boards", "Доски"], ["last", "Последнюю страницу"]]
          .map(([v, l]) => `<option value="${v}"${settings.start_page === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    </section>

    <section class="glass set-card rise" style="--d:2">
      <h2>💾 Данные и резервные копии</h2>
      <div class="set-row"><div class="lbl"><b>Папка данных</b><small>Каталог, теги, заметки, доски, превью</small><br><code>${esc(about.data_dir)}</code></div>
        <button id="sOpenData">Открыть</button></div>
      <div class="set-row"><div class="lbl"><b>Автоматическая копия</b><small>Раз в день при запуске, хранятся последние 7</small></div>${sw("auto_backup")}</div>
      <div class="set-row"><div class="lbl"><b>Резервная копия</b><small>Теги, оценки, заметки, доски и журнал практики. Сами картинки остаются в ваших папках.</small></div>
        <div class="row"><button id="sBackup" class="primary">Создать копию</button><button id="sRestoreFile">Восстановить из файла…</button></div></div>
      <input type="file" id="sRestoreInput" accept=".zip" hidden>
      ${backups.length ? `<div class="backups">${backups.slice(0, 20).map((b) => `
        <div class="b"><span title="${esc(b.path)}">${b.auto ? "🕒" : "💾"} ${new Date(b.time * 1000).toLocaleString()} · ${fmtSize(b.size)}</span>
          <button class="mini ghost" data-reveal="${esc(b.path)}">Показать</button><button class="mini" data-restore="${esc(b.path)}">Восстановить</button></div>`).join("")}</div>` : ""}
    </section>

    <section class="glass set-card rise" style="--d:3">
      <h2>📌 Pinterest</h2>
      <div class="set-row"><div class="lbl"><b>Проверять подключённые доски</b><small>Каждые несколько часов, пока Refis открыт</small></div>${sw("pinterest_sync")}</div>
      <div class="set-row"><div class="lbl"><b>Собирать рекомендации</b><small>Пины из вашей домашней ленты, пока вы листаете её в окне «Pinterest» внутри Refis</small></div>${sw("pinterest_feed")}</div>
    </section>

    <section class="glass set-card rise" style="--d:4">
      <h2>⬆️ Обновления</h2>
      <div class="set-row"><div class="lbl"><b>Версия ${esc(about.version)}</b><small id="updState">${update ? updText(update) : "Проверка при запуске"}</small></div>
        <button id="sCheck">Проверить сейчас</button></div>
      <div class="set-row"><div class="lbl"><b>Проверять при запуске</b><small>Только запрос номера последней версии на GitHub — никаких данных о вас</small></div>${sw("check_updates")}</div>
      <div id="updBox">${update?.newer ? updBox(update) : ""}</div>
    </section>

    <section class="glass set-card rise" style="--d:5">
      <div class="about">
        <img src="img/logo.svg" alt="">
        <div><h2>Refis ${esc(about.version)}</h2>
          <p>Библиотека референсов для художников. Свободная программа под лицензией MIT.</p>
          <div class="row">
            <button id="aGit">GitHub</button>
            <button id="aBug">Сообщить об ошибке</button>
            <button id="aKeys">Горячие клавиши</button>
            ${about.telegram ? `<button id="aTg" class="tg-btn">✈ Telegram автора</button>` : ""}
          </div></div>
      </div>
    </section>`;

  $$(".seg[data-key]", root).forEach((g) => g.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    $$("button", g).forEach((x) => x.classList.toggle("on", x === b));
    await save({ [g.dataset.key]: b.dataset.v });
    if (g.dataset.key === "lang") location.reload();
  }));
  $$("input[type=checkbox][data-key]", root).forEach((c) => (c.onchange = () => save({ [c.dataset.key]: c.checked })));
  $$("select[data-key]", root).forEach((c) => (c.onchange = () => save({ [c.dataset.key]: c.value })));
  $("#sOpenData").onclick = () => api("/open-data-dir", { method: "POST" });
  $("#sBackup").onclick = async (e) => {
    e.currentTarget.disabled = true;
    const r = await api("/backup", { method: "POST" });
    toast(`Копия сохранена: ${r.path}`, { action: "Показать", life: 7000, onAction: () => api("/backup/reveal", { method: "POST", body: { path: r.path } }) });
    renderSettings();
  };
  $("#sRestoreFile").onclick = () => $("#sRestoreInput").click();
  $("#sRestoreInput").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    confirmRestore(async () => {
      const fd = new FormData();
      fd.append("file", f, f.name);
      await api("/restore", { method: "POST", body: fd });
      restartNotice();
    });
  };
  $$("[data-reveal]", root).forEach((b) => (b.onclick = () => api("/backup/reveal", { method: "POST", body: { path: b.dataset.reveal } })));
  $$("[data-restore]", root).forEach((b) => (b.onclick = () => confirmRestore(async () => {
    await api("/restore/from", { method: "POST", body: { path: b.dataset.restore } });
    restartNotice();
  })));
  $("#sCheck").onclick = async (e) => {
    const btn = e.currentTarget; // после await currentTarget уже null
    btn.disabled = true;
    update = await api("/update?force=true");
    $("#updState").textContent = updText(update);
    $("#updBox").innerHTML = update.newer ? updBox(update) : "";
    bindUpdate();
    btn.disabled = false;
  };
  bindUpdate();
  $("#aGit").onclick = () => openUrl(`https://github.com/${about.repo}`);
  $("#aBug").onclick = async () => openUrl((await api("/report-url")).url);
  $("#aKeys").onclick = shortcuts;
  if ($("#aTg")) $("#aTg").onclick = () => openUrl(about.telegram);
}

function updText(u) {
  if (u.error && !u.latest) return "Не удалось проверить — нет связи с GitHub или релизов ещё нет";
  return u.newer ? `Доступна версия ${u.latest}` : `Установлена последняя версия`;
}
function updBox(u) {
  return `<div class="update-box"><b>Refis ${esc(u.latest)}</b>${u.published ? ` · ${new Date(u.published).toLocaleDateString()}` : ""}
    ${u.notes ? `<pre>${esc(u.notes)}</pre>` : ""}
    <div class="row" style="margin-top:10px"><button class="primary" id="updGet">${u.download ? "Скачать установщик" : "Открыть страницу релиза"}</button>
    <span class="hint">Установщик обновит программу, данные сохранятся</span></div></div>`;
}
function bindUpdate() {
  const b = $("#updGet");
  if (b) b.onclick = () => openUrl(update.download || update.url);
}

function confirmRestore(run) {
  confirmDialog("Восстановить из копии?",
    "Текущие теги, заметки и доски заменятся данными из копии (сами картинки на диске не трогаются). Нынешнее состояние будет сохранено в отдельную копию. Восстановление применится после перезапуска Refis.",
    run, "Восстановить");
}

function restartNotice() {
  const canRestart = !!window.pywebview?.api?.restart;
  modal(`<h2>Почти готово</h2><p>Копия подготовлена. Перезапустите Refis, чтобы применить её.</p>
    <div class="actions">${canRestart ? `<button data-close>Позже</button><button class="primary" id="rNow">Перезапустить</button>` : `<button class="primary" data-close>Понятно</button>`}</div>`,
    (box) => { if (canRestart) $("#rNow", box).onclick = () => window.pywebview.api.restart(); });
}

function shortcuts() {
  const rows = [
    ["Ctrl K", "Командная панель — быстрый переход куда угодно"], ["Ctrl 1…5", "Сегодня, Библиотека, Доски, Порядок, Pinterest"],
    ["Ctrl F, /", "Поиск"], ["Пробел, Enter", "Открыть просмотр"], ["1–5, 0", "Оценка / сброс"], ["F", "Избранное"],
    ["T", "Добавить тег"], ["I", "Панель деталей"], ["Ctrl C / Ctrl V", "Копировать картинку / вставить из буфера"],
    ["H, G, B, S, R", "Просмотр: зеркало, ч/б, пятна, сетка, поворот"], [", .  [ ]", "Видео: кадр назад/вперёд, скорость"],
    ["Ctrl Z, Ctrl D, A, F, N", "Доска: отмена, копия, упорядочить, показать всё, заметка"],
    ["1–9, Enter", "Разметка: подсказка, дальше"],
  ];
  modal(`<h2>Горячие клавиши</h2><dl class="keys">${rows.map(([k, d]) => `<dt><kbd>${k}</kbd></dt><dd>${d}</dd>`).join("")}</dl>
    <div class="actions"><button class="primary" data-close>Закрыть</button></div>`);
}
