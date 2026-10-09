// Страница Pinterest: подключённые доски, новые пины, сохранение в библиотеку.
import { $, $$, api, esc, toast, modal, menu, confirmDialog, emit, plural, files, store } from "./util.js";
import { openViewer } from "./viewer.js";
import { state as lib, loadTags, loadFolders } from "./library.js";
import { openUrl } from "./settings.js";

const PG = { status: "new", source: 0, items: [], sel: new Set(), sources: [] };
const pinsWord = (n) => `${n} ${plural(n, "пин", "пина", "пинов")}`;

export async function renderPinterest() {
  const root = $("#pinterest");
  PG.sources = await api("/pinterest/sources");
  updatePinBadge(PG.sources);
  if (!PG.sources.length) return renderConnect(root);
  root.innerHTML = `
    <header class="rise pin-head"><div><h1>Pinterest</h1>
      <p class="muted">Новые пины с ваших досок. Сохраните нужные в библиотеку — они получат тег доски и попадут в задания.</p></div>
      <div class="row"><button id="pinSync">⟳ Обновить</button><button id="pinAdd">＋ Подключить доску</button>
        <button class="primary" id="pinOpen">✨ Открыть Pinterest</button></div></header>
    <div class="pin-sources rise" style="--d:1">
      <button class="chip-btn ${PG.source ? "" : "on"}" data-s="0">Все доски</button>
      ${PG.sources.map((s) => `<button class="chip-btn ${PG.source === s.id ? "on" : ""} ${s.last_error ? "err" : ""}" data-s="${s.id}" title="${esc(s.last_error || (s.kind === "feed" ? "Пины из вашей домашней ленты" : s.page))}">
        ${s.kind === "feed" ? "✨" : s.kind === "user" ? "👤" : "📌"} ${esc(s.title || s.page)} ${s.new ? `<b>${s.new}</b>` : ""}${s.auto_save ? " ⬇" : ""}</button>`).join("")}
    </div>
    ${PG.sources.filter((s) => s.last_error).map((s) => `<div class="pin-err rise">⚠ «${esc(s.title)}»: ${esc(s.last_error)}</div>`).join("")}
    <div class="row pin-tabs rise" style="--d:2">
      <div class="seg" id="pinTabs">
        <button data-st="new" class="${PG.status === "new" ? "on" : ""}">Новые</button>
        <button data-st="saved" class="${PG.status === "saved" ? "on" : ""}">Сохранённые</button>
        <button data-st="hidden" class="${PG.status === "hidden" ? "on" : ""}">Скрытые</button>
      </div>
      <span class="sp"></span>
      <span class="muted" id="pinSelInfo"></span>
      <button id="pinSelAll" class="ghost">Выбрать все</button>
      <button id="pinHide" disabled>Скрыть</button>
      <button id="pinSave" class="primary" disabled>⬇ В библиотеку</button>
    </div>
    <div class="pin-grid" id="pinGrid"></div>`;
  $("#pinSync").onclick = syncAll;
  $("#pinOpen").onclick = openPinterestWindow;
  $("#pinAdd").onclick = () => connectDialog();
  $$(".pin-sources [data-s]").forEach((b) => {
    b.onclick = () => { PG.source = +b.dataset.s; PG.sel.clear(); renderPinterest(); };
    if (+b.dataset.s) b.oncontextmenu = (e) => { e.preventDefault(); sourceMenu(e, PG.sources.find((s) => s.id === +b.dataset.s)); };
  });
  $$("#pinTabs button").forEach((b) => (b.onclick = () => { PG.status = b.dataset.st; PG.sel.clear(); renderPinterest(); }));
  $("#pinSelAll").onclick = () => { PG.items.forEach((p) => PG.sel.add(p.id)); markSel(); };
  $("#pinHide").onclick = () => setStatus([...PG.sel], PG.status === "hidden" ? "new" : "hidden");
  $("#pinSave").onclick = () => saveDialog([...PG.sel]);
  if (PG.status === "hidden") $("#pinHide").textContent = "Вернуть в новые";
  if (PG.status === "saved") { $("#pinHide").hidden = true; $("#pinSave").hidden = true; $("#pinSelAll").hidden = true; }
  loadPins();
}

function renderConnect(root) {
  root.innerHTML = `
    <div class="glass pin-hero rise">
      <div class="logo">📌</div>
      <h1>Подключите Pinterest</h1>
      <p><b>Рекомендации.</b> Откройте Pinterest внутри Refis и войдите в свой аккаунт — пока вы листаете домашнюю ленту,
        Refis собирает её пины в «Рекомендации», а на каждом пине появляется кнопка «＋ Refis» для сохранения в библиотеку.</p>
      <div class="row"><button class="primary" id="pinOpen">✨ Открыть Pinterest в Refis</button></div>
      <p style="margin-top:14px"><b>Доски.</b> Или вставьте ссылку на свою публичную доску или профиль — Refis будет сам забирать новые пины.
        Они получат тег по названию доски и попадут в задания «Нарисуй это».</p>
      <div class="row pin-input"><input type="text" id="pinUrl" placeholder="https://pinterest.com/имя/название-доски/">
        <button class="primary" id="pinGo">Подключить</button></div>
      <div class="hint">Примеры: <code>pinterest.com/anna_art/anatomy/</code> — доска · <code>anna_art</code> — последние пины профиля.<br>
        Работают только <b>публичные</b> доски — секретные Pinterest не отдаёт без официального API.
        Ссылку на доску можно скопировать в браузере или в приложении (Поделиться → Копировать ссылку).</div>
    </div>`;
  const go = async () => {
    const url = $("#pinUrl").value.trim();
    if (!url) return;
    $("#pinGo").disabled = true; $("#pinGo").textContent = "Подключаю…";
    try { await connect(url); } finally { const b = $("#pinGo"); if (b) { b.disabled = false; b.textContent = "Подключить"; } }
  };
  $("#pinGo").onclick = go;
  $("#pinOpen").onclick = openPinterestWindow;
  $("#pinUrl").onkeydown = (e) => { if (e.key === "Enter") go(); };
  setTimeout(() => $("#pinUrl")?.focus(), 50);
}

async function connect(url, extra = {}) {
  const r = await api("/pinterest/sources", { method: "POST", body: { url, ...extra } });
  if (r.error) toast(`Подключено, но лента не загрузилась: ${r.error}`, { error: true, life: 6000 });
  else toast(`Подключено: ${pinsWord(r.added)}`);
  PG.source = r.id; PG.status = "new";
  renderPinterest();
}

function connectDialog() {
  modal(`<h2>Подключить доску</h2>
    <p>Ссылка на публичную доску или профиль Pinterest.</p>
    <input type="text" id="cUrl" placeholder="https://pinterest.com/имя/доска/">
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="cOk">Подключить</button></div>`,
    (box, close) => {
      const ok = async () => { const u = $("#cUrl", box).value.trim(); if (!u) return; $("#cOk", box).disabled = true; try { await connect(u); close(); } catch { $("#cOk", box).disabled = false; } };
      $("#cOk", box).onclick = ok;
      $("#cUrl", box).onkeydown = (e) => { if (e.key === "Enter") ok(); };
    });
}

async function loadPins() {
  const p = new URLSearchParams({ status: PG.status, limit: 300 });
  if (PG.source) p.set("source", PG.source);
  const { items, total } = await api("/pinterest/pins?" + p);
  PG.items = items;
  const grid = $("#pinGrid");
  if (!grid) return;
  if (!items.length) {
    grid.innerHTML = `<div class="empty-state"><div class="big">${PG.status === "new" ? "✨" : "📭"}</div>
      <h2>${PG.status === "new" ? "Новых пинов нет" : "Пусто"}</h2>
      <p>${PG.status === "new" ? "Всё разобрано. Refis проверяет доски каждые несколько часов, можно обновить вручную." : ""}</p></div>`;
    markSel();
    return;
  }
  grid.innerHTML = items.map((p, i) => `
    <div class="pin ${PG.sel.has(p.id) ? "sel" : ""}" data-id="${p.id}" style="--i:${Math.min(i, 30)}">
      <img src="/api/pinterest/pins/${p.id}/img" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.parentElement.classList.add('broken')">
      <span class="check">✓</span>
      <div class="cap">${esc(p.title || "")}<small>${esc(p.board)}</small></div>
    </div>`).join("") + (total > items.length ? `<div class="hint">Показано ${items.length} из ${total}</div>` : "");
  $$(".pin", grid).forEach((el) => {
    const id = +el.dataset.id;
    el.onclick = (e) => {
      if (PG.status === "saved") return openPin(id, el);
      PG.sel.has(id) ? PG.sel.delete(id) : PG.sel.add(id);
      markSel();
    };
    el.ondblclick = () => openPin(id, el);
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const p = PG.items.find((x) => x.id === id);
      menu(e, [
        ["Открыть", () => openPin(id, el)],
        p.status !== "saved" && ["Сохранить в библиотеку…", () => saveDialog([id])],
        p.status === "new" && ["Скрыть", () => setStatus([id], "hidden")],
        p.status === "hidden" && ["Вернуть в новые", () => setStatus([id], "new")],
        p.link && ["Открыть на Pinterest", () => openUrl(p.link)],
      ]);
    };
  });
  markSel();
}

function markSel() {
  $$("#pinGrid .pin").forEach((el) => el.classList.toggle("sel", PG.sel.has(+el.dataset.id)));
  const n = PG.sel.size;
  const info = $("#pinSelInfo");
  if (!info) return;
  info.textContent = n ? `выбрано ${n}` : "";
  $("#pinSave").disabled = !n;
  $("#pinHide").disabled = !n;
}

function openPin(id, el) {
  const items = PG.items.map((p) => ({
    id: p.id, external: true, type: "image", name: p.title || p.board, tags: [p.board],
    src: `/api/pinterest/pins/${p.id}/img?full=true`, thumb: `/api/pinterest/pins/${p.id}/img`,
  }));
  openViewer({ items, cardEl: (pid) => $(`#pinGrid .pin[data-id="${pid}"]`) }, id, el);
}

async function setStatus(ids, status) {
  await api("/pinterest/pins/status", { method: "POST", body: { ids, status } });
  PG.sel.clear();
  toast(status === "hidden" ? `Скрыто: ${pinsWord(ids.length)}` : "Возвращено в новые");
  renderPinterest();
}

function saveDialog(ids) {
  if (!lib.folders.length) return toast("Сначала добавьте папку библиотеки (раздел «Порядок»)");
  const last = store("pinSave") || {};
  const fid = last.folder && lib.folders.some((f) => f.id === last.folder) ? last.folder : lib.folders[0].id;
  const boards = [...new Set(PG.items.filter((p) => ids.includes(p.id)).map((p) => p.board))];
  modal(`<h2>Сохранить ${pinsWord(ids.length)}</h2>
    <p>Картинки скачаются в оригинальном размере. Теги — по названию доски и «pinterest», ссылка на пин — в поле «Источник».</p>
    <div class="field"><label>Папка библиотеки</label>
      <select id="sFolder">${lib.folders.map((f) => `<option value="${f.id}"${f.id === fid ? " selected" : ""}>${esc(f.path)}</option>`).join("")}</select></div>
    <div class="field"><label>Подпапка</label><input type="text" id="sSub" placeholder="Pinterest\\${esc(boards[0] || "доска")}" value="">
      <span class="hint">Пусто — отдельная подпапка для каждой доски: Pinterest\\название</span></div>
    <div class="field"><label>Свои теги вместо автоматических</label><input type="text" id="sTags" list="tagOptions" placeholder="необязательно, через запятую"></div>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="sOk">Сохранить</button></div>`,
    (box, close) => {
      $("#sOk", box).onclick = async () => {
        const folder_id = +$("#sFolder", box).value;
        const sub = $("#sSub", box).value.trim();
        const tags = $("#sTags", box).value.split(",").map((t) => t.trim()).filter(Boolean);
        store("pinSave", { folder: folder_id });
        $("#sOk", box).disabled = true; $("#sOk", box).textContent = "Скачиваю…";
        const r = await api("/pinterest/pins/save", { method: "POST", body: { ids, folder_id, subdir: sub || null, tags: tags.length ? tags : null } });
        close();
        PG.sel.clear();
        toast(r.errors.length ? `Сохранено ${r.saved.length}, не удалось ${r.errors.length} (нет связи?)` : `В библиотеке: ${files(r.saved.length)}`,
          { error: !!r.errors.length, action: r.saved.length ? "Показать" : null, life: 5000,
            onAction: () => { emit("navigate", "library"); emit("library-reload"); } });
        loadTags(); loadFolders(); emit("poll");
        renderPinterest();
      };
    });
}

/** Окно с pinterest.com внутри Refis (только в приложении; в браузере — обычная вкладка). */
export async function openPinterestWindow() {
  if (window.pywebview?.api?.open_pinterest) {
    await window.pywebview.api.open_pinterest();
    toast("Войдите в Pinterest и листайте ленту — рекомендации появятся здесь", { life: 6000 });
    clearInterval(PG.watch);
    PG.watch = setInterval(async () => {
      updatePinBadge(await api("/pinterest/sources").catch(() => []));
      if ($('.page[data-page="pinterest"]').classList.contains("active") && !PG.sel.size) loadPins();
    }, 8000);
    return;
  }
  openUrl("https://www.pinterest.com/");
  toast("Сбор рекомендаций и кнопка «＋ Refis» работают в окне приложения Refis, а не в браузере", { life: 7000 });
}

function sourceMenu(e, s) {
  menu(e, [
    s.kind === "feed" && ["Открыть Pinterest", openPinterestWindow],
    s.kind !== "feed" && ["Обновить", async () => { const r = await api(`/pinterest/sources/${s.id}/sync`, { method: "POST" }); toast(r.error ? r.error : `Новых: ${r.added}`, { error: !!r.error }); renderPinterest(); }],
    ["Настройки…", () => sourceSettings(s)],
    ["Открыть в браузере", () => openUrl(s.page)],
    "-",
    ["Отключить…", () => confirmDialog("Отключить доску?", `«${s.title}» исчезнет из Refis вместе с несохранёнными пинами. Уже сохранённые картинки останутся в библиотеке.`,
      async () => { await api(`/pinterest/sources/${s.id}`, { method: "DELETE" }); PG.source = 0; renderPinterest(); }, "Отключить")],
  ]);
}

function sourceSettings(s) {
  modal(`<h2>${esc(s.title)}</h2><p style="word-break:break-all">${esc(s.page)}</p>
    <div class="field"><label>Название</label><input type="text" id="ssTitle" value="${esc(s.title)}"></div>
    <div class="field"><label>Тег для сохранённых пинов</label><input type="text" id="ssTag" list="tagOptions" value="${esc(s.tag)}" placeholder="например: анатомия/торс"></div>
    <label class="check"><input type="checkbox" id="ssAuto"${s.auto_save ? " checked" : ""}> Сохранять новые пины в библиотеку автоматически</label>
    <div class="field"><label>Папка для автосохранения</label>
      <select id="ssFolder"><option value="">—</option>${lib.folders.map((f) => `<option value="${f.id}"${f.id === s.folder_id ? " selected" : ""}>${esc(f.path)}</option>`).join("")}</select></div>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="ssOk">Сохранить</button></div>`,
    (box, close) => {
      $("#ssOk", box).onclick = async () => {
        const folder = $("#ssFolder", box).value;
        const auto = $("#ssAuto", box).checked;
        if (auto && !folder) return toast("Выберите папку для автосохранения");
        await api(`/pinterest/sources/${s.id}`, { method: "PATCH", body: {
          title: $("#ssTitle", box).value.trim(), tag: $("#ssTag", box).value.trim(), auto_save: auto, folder_id: folder ? +folder : null } });
        close(); renderPinterest();
      };
    });
}

async function syncAll() {
  const b = $("#pinSync");
  b.disabled = true; b.innerHTML = `<span class="scanning">Обновляю</span>`;
  for (const s of PG.sources) await api(`/pinterest/sources/${s.id}/sync`, { method: "POST" }).catch(() => {});
  renderPinterest();
}

export function updatePinBadge(sources) {
  const n = (sources || []).reduce((a, s) => a + s.new, 0);
  const b = $("#pinBadge");
  if (b) b.textContent = n || "";
}
