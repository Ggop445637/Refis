// Точка входа: навигация, командная палитра, горячие клавиши, вставка/перетаскивание, статус.
import { tr, translateStatic, rememberLang } from "./i18n.js";
import { $, $$, api, esc, store, toast, on, emit, transition, isTyping, clipboardImages, modalOpen, closeModal, files } from "./util.js";
import {
  state as lib, initLibrary, load, loadTags, loadFolders, loadSaved, libraryKey, uploadDialog, folderDialog,
  applyQuery, toggleTag, toggleDetails, filterParams, layout,
} from "./library.js";
import { viewerOpen, viewerKey } from "./viewer.js";
import { practiceOpen, practiceKey, practiceDialog } from "./practice.js";
import { renderToday, startChallenge } from "./today.js";
import { renderBoards, openBoard, createBoard, boardKey, boardPaste, boardDrop, boardActive, leaveBoard } from "./boards.js";
import { renderOrganize, openTriage, triageOpen, triageKey, updateBadge } from "./organize.js";
import { renderPinterest, updatePinBadge } from "./pinboard.js";
import { loadSettings, renderSettings, checkUpdatesOnStart, settings as appSettings } from "./settings.js";
import { renderProfile } from "./profile.js";
import { openPackFile, importPack, isPackFile } from "./packs.js";
import { createFolderDialog } from "./folders.js";
import { loadSections, sectionDialog } from "./sections.js";

let page = null;
let libLoaded = false;

// ======================================================================= навигация

function movePill(navSel) {
  const nav = $(navSel);
  const pill = $(".pill", nav);
  const active = $("button.active", nav);
  if (!active || (navSel === "#views" && page !== "library")) { pill.style.opacity = 0; return; }
  pill.style.opacity = 1;
  pill.style.transform = `translateY(${active.offsetTop}px)`;
  pill.style.height = active.offsetHeight + "px";
}
on("pill", (sel) => requestAnimationFrame(() => movePill(sel)));

export function go(p) {
  if (p === page) return;
  const prev = page;
  if (prev === "board") leaveBoard();
  page = p; // сразу, а не в анимации: повторный go(p) до её начала не должен запускать вторую
  const swap = () => {
    document.body.dataset.page = p;
    $$(".page").forEach((el) => el.classList.toggle("active", el.dataset.page === p));
    const navPage = p === "board" ? "boards" : p;
    $$("#mainNav button").forEach((b) => b.classList.toggle("active", b.dataset.page === navPage));
    movePill("#mainNav");
    movePill("#views");
    if (!document.startViewTransition) {
      const el = $(`.page[data-page="${p}"]`);
      el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
    }
  };
  transition(swap);
  if (p !== "board" && p !== "settings") store("page", p);
  $("#settingsBtn").classList.toggle("on", p === "settings");
  if (p === "today") renderToday();
  if (p === "boards") renderBoards();
  if (p === "organize") renderOrganize();
  if (p === "pinterest") renderPinterest();
  if (p === "settings") renderSettings();
  if (p === "profile") renderProfile();
  if (p === "library") {
    if (!libLoaded) { libLoaded = true; load(); }
    else requestAnimationFrame(layout);
  }
}
on("navigate", go);

$("#mainNav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (b) go(b.dataset.page);
});

// ======================================================================= статус сканирования

let pollTimer = null, wasBusy = false;
async function poll() {
  clearTimeout(pollTimer);
  const s = await api("/status").catch(() => null);
  if (!s) { pollTimer = setTimeout(poll, 5000); return; }
  $('[data-count="all"]').textContent = s.total - (s.missing || 0) || "";
  const busy = s.scan.running || s.thumbs_pending > 0;
  let text = "";
  if (s.scan.running) text = `${tr("Сканирую… новых")}: ${s.scan.added}`;
  else if (s.thumbs_pending) text = `${tr("Создаю превью… осталось")} ${s.thumbs_pending}`;
  if (!s.ffmpeg) text += (text ? " · " : "") + tr("ffmpeg не найден — нет превью видео");
  const st = $("#scanText");
  st.textContent = text;
  st.className = busy ? "scanning" : "";
  if (busy) {
    pollTimer = setTimeout(poll, 1500);
    if (s.scan.running && page === "library" && !lib.selected.size && $("#gridwrap").scrollTop < 50) { loadFolders(); load(); }
  }
  if (wasBusy && !busy) {
    loadFolders(); loadTags();
    if (page === "organize") renderOrganize();
    if (page === "library") load();
    if (page === "today") renderToday();
  }
  if (!busy) pollTimer = setTimeout(poll, 15000);
  wasBusy = busy;
}
on("poll", poll);

// ======================================================================= поверх окон

let pinned = false;
async function togglePin() {
  if (!window.pywebview?.api?.set_on_top) return toast(tr("Доступно только в приложении"));
  pinned = await window.pywebview.api.set_on_top(!pinned);
  $("#pinBtn").classList.toggle("on", pinned);
  $("#bPin")?.classList.toggle("on", pinned);
  toast(pinned ? tr("📌 Окно поверх остальных") : tr("Окно больше не поверх остальных"), { life: 1600 });
}
on("toggle-pin", togglePin);
$("#pinBtn").onclick = togglePin;
addEventListener("pywebviewready", () => { $("#pinBtn").hidden = false; const b = $("#bPin"); if (b) b.hidden = false; });

// ======================================================================= командная палитра

function commands() {
  const list = [
    { g: tr("Переход"), ic: "☀", t: tr("Сегодня"), run: () => go("today"), k: "Ctrl 1" },
    { g: tr("Переход"), ic: "▦", t: tr("Библиотека"), run: () => go("library"), k: "Ctrl 2" },
    { g: tr("Переход"), ic: "◫", t: tr("Доски"), run: () => go("boards"), k: "Ctrl 3" },
    { g: tr("Переход"), ic: "🧹", t: tr("Порядок в библиотеке"), run: () => go("organize"), k: "Ctrl 4" },
    { g: tr("Переход"), ic: "📌", t: "Pinterest", run: () => go("pinterest"), k: "Ctrl 5" },
    { g: tr("Действия"), ic: "🎲", t: tr("Нарисуй это — задание из моих тем"), run: () => startChallenge() },
    { g: tr("Действия"), ic: "🏷", t: tr("Быстрая разметка файлов без тегов"), run: () => openTriage() },
    { g: tr("Действия"), ic: "⏱", t: tr("Тренировка набросков"), run: () => { go("library"); practiceDialog({ params: filterParams(), total: lib.total }); } },
    { g: tr("Действия"), ic: "◫", t: tr("Новая доска"), run: () => createBoard() },
    { g: tr("Действия"), ic: "📦", t: tr("Открыть набор референсов (.refis)…"), run: openPackFile },
    { g: tr("Действия"), ic: "📁", t: tr("Создать новую папку…"), run: () => createFolderDialog() },
    { g: tr("Действия"), ic: "＋", t: tr("Новый раздел…"), run: () => { go("library"); sectionDialog(); } },
    { g: tr("Действия"), ic: "＋", t: tr("Подключить существующую папку…"), run: () => folderDialog() },
    { g: tr("Действия"), ic: "⟳", t: tr("Пересканировать все папки"), run: async () => { await api("/scan", { method: "POST" }); poll(); toast(tr("Сканирую…")); } },
    { g: tr("Действия"), ic: "◨", t: tr("Показать/скрыть панель деталей"), run: () => { go("library"); toggleDetails(); }, k: "I" },
    { g: tr("Действия"), ic: "📌", t: tr("Окно поверх всех окон"), run: togglePin },
    { g: tr("Переход"), ic: "👤", t: tr("Профиль и статистика"), run: () => go("profile") },
    { g: tr("Переход"), ic: "⚙", t: tr("Настройки"), run: () => go("settings") },
    { g: tr("Действия"), ic: "💾", t: tr("Создать резервную копию"), run: async () => { const r = await api("/backup", { method: "POST" }); toast(`${tr("Копия")}: ${r.path}`, { life: 6000 }); } },
    { g: tr("Библиотека"), ic: "★", t: tr("Избранное"), run: () => { go("library"); applyQuery({ view: "fav" }); } },
    { g: tr("Библиотека"), ic: "🏷", t: tr("Файлы без тегов"), run: () => { go("library"); applyQuery({ view: "untagged" }); } },
    { g: tr("Библиотека"), ic: "⧉", t: tr("Дубликаты"), run: () => { go("library"); applyQuery({ view: "dupes" }); } },
    { g: tr("Библиотека"), ic: "▶", t: tr("Только видео"), run: () => { go("library"); applyQuery({ type: "video" }); } },
    { g: tr("Библиотека"), ic: "🔀", t: tr("Случайный порядок"), run: () => { go("library"); const { view, folder, tags, ntags, q, type, orient, minRating } = lib; applyQuery({ view, folder, tags, ntags, q, type, orient, minRating, sort: "random" }); } },
  ];
  (lib.saved || []).forEach((s) => list.push({ g: tr("Сохранённые поиски"), ic: "☆", t: s.name, run: () => { go("library"); applyQuery(s.query); } }));
  (paletteBoards || []).forEach((b) => list.push({ g: tr("Доски"), ic: "◫", t: b.name, run: () => openBoard(b.id) }));
  lib.allTags.forEach((t) => list.push({ g: tr("Теги"), ic: "#", t: t.name, sub: t.count, run: () => { lib.tags = []; lib.ntags = []; toggleTag(t.name); } }));
  return list;
}
let paletteBoards = [];

function score(q, t) {
  if (!q) return 1;
  t = t.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  let j = 0, s = 0;
  for (const ch of t) { if (ch === q[j]) { j++; s++; } if (j === q.length) break; }
  return j === q.length ? s : 0;
}
function highlight(q, t) {
  const i = t.toLowerCase().indexOf(q);
  if (!q || i < 0) return esc(t);
  return esc(t.slice(0, i)) + "<b>" + esc(t.slice(i, i + q.length)) + "</b>" + esc(t.slice(i + q.length));
}

async function openPalette() {
  const p = $("#palette");
  if (!p.hidden) return closePalette();
  api("/boards").then((b) => (paletteBoards = b)).catch(() => {});
  p.innerHTML = `<div class="pal"><input id="palIn" placeholder="${tr("Что сделать? Поиск по командам, тегам, доскам…")}" autocomplete="off"><ul id="palList"></ul></div>`;
  p.hidden = false;
  let sel = 0, shown = [];
  const draw = () => {
    const q = $("#palIn").value.trim().toLowerCase();
    shown = commands().map((c) => ({ c, s: score(q, c.t) })).filter((x) => x.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0)).slice(0, 40).map((x) => x.c);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let g = null;
    $("#palList").innerHTML = shown.map((c, i) => {
      const head = !q && c.g !== g ? `<div class="group">${esc((g = c.g))}</div>` : "";
      return `${head}<li data-i="${i}" class="${i === sel ? "on" : ""}"><span class="ic">${c.ic}</span><span>${highlight(q, c.t)}</span>${c.k ? `<kbd class="sub">${c.k}</kbd>` : c.sub ? `<span class="sub">${c.sub}</span>` : ""}</li>`;
    }).join("") || `<li class="muted">${tr("Ничего не найдено")}</li>`;
    $("#palList li.on")?.scrollIntoView({ block: "nearest" });
  };
  const run = (i) => { const c = shown[i]; closePalette(); c?.run(); };
  $("#palIn").oninput = () => { sel = 0; draw(); };
  $("#palIn").onkeydown = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(shown.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") run(sel);
    else if (e.key === "Escape") closePalette();
  };
  $("#palList").onclick = (e) => { const li = e.target.closest("li[data-i]"); if (li) run(+li.dataset.i); };
  p.onpointerdown = (e) => { if (e.target === p) closePalette(); };
  draw();
  setTimeout(() => $("#palIn").focus(), 10);
}
function closePalette() { $("#palette").hidden = true; }
$("#cmdkBtn").onclick = openPalette;
$("#settingsBtn").onclick = () => go("settings");

// ======================================================================= клавиатура

addEventListener("keydown", (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (k === "k" || k === "л")) { e.preventDefault(); openPalette(); return; }
  if (!$("#palette").hidden) return;
  if (modalOpen()) { if (k === "Escape") closeModal(); return; }
  if (practiceOpen()) { e.preventDefault(); practiceKey(e); return; }
  if (triageOpen()) { if (triageKey(e) && !isTyping(e)) e.preventDefault(); return; }
  if (viewerOpen()) { if (!isTyping(e)) { e.preventDefault(); viewerKey(e); } return; }
  if (ctrl && ["1", "2", "3", "4", "5"].includes(k)) { e.preventDefault(); go({ 1: "today", 2: "library", 3: "boards", 4: "organize", 5: "pinterest" }[k]); return; }
  if ((ctrl && (k === "f" || k === "а")) || (k === "/" && !isTyping(e))) {
    e.preventDefault(); go("library"); setTimeout(() => $("#search").focus(), 30); return;
  }
  if (isTyping(e)) { if (k === "Escape") e.target.blur(); return; }
  if (page === "board" && boardKey(e)) { e.preventDefault(); return; }
  if (page === "library" && libraryKey(e)) { e.preventDefault(); return; }
});

// ======================================================================= вставка и перетаскивание

addEventListener("paste", (e) => {
  const imgs = clipboardImages(e);
  if (!imgs.length) return;
  if (isTyping(e) && !e.target.closest(".tagedit")) return;
  e.preventDefault();
  if (boardPaste(e)) return;
  uploadDialog(imgs);
});

let dragDepth = 0;
// файлы из проводника, а не карточки, которые перетаскивают на папку
const hasFiles = (e) => { const t = [...(e.dataTransfer?.types || [])]; return t.includes("Files") && !t.includes("text/x-refis-ids"); };
addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || page === "board") return;
  dragDepth++;
  $("#dropzone").hidden = false;
});
addEventListener("dragleave", (e) => {
  if (!hasFiles(e) || page === "board") return;
  if (--dragDepth <= 0) { dragDepth = 0; $("#dropzone").hidden = true; }
});
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#dropzone").hidden = true;
  const pack = [...e.dataTransfer.files].find(isPackFile);
  if (pack) return importPack(pack);
  if (page === "board") return boardDrop(e);
  const list = [...e.dataTransfer.files].filter((f) => /\.(jpe?g|jfif|png|gif|webp|bmp|tiff?|psd|mp4|webm|mov|m4v|mkv|avi|wmv|flv|mpe?g)$/i.test(f.name));
  if (!list.length) return toast(tr("Здесь нет картинок или видео"));
  uploadDialog(list);
});

addEventListener("resize", () => { movePill("#mainNav"); movePill("#views"); });

// ======================================================================= старт

(async function init() {
  translateStatic();
  await loadSettings().catch(() => {});
  if (appSettings.lang && rememberLang(appSettings.lang)) return location.reload(); // язык сменили в другом окне
  await loadSections().catch(() => {});
  initLibrary();
  await Promise.all([loadFolders(), loadTags(), loadSaved()]).catch(() => {});
  const start = appSettings.start_page === "last" ? store("page") : appSettings.start_page;
  go(start || "today");
  setTimeout(checkUpdatesOnStart, 2500);
  api("/organize/health").then(updateBadge).catch(() => {});
  api("/pinterest/sources").then(updatePinBadge).catch(() => {});
  requestAnimationFrame(() => { movePill("#mainNav"); movePill("#views"); });
  poll();
})();
