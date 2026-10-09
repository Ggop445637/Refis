// Библиотека: фильтры, сетка с раскладкой, выделение, панель деталей, теги, папки, загрузка.
import { tr, plural } from "./i18n.js";
import {
  $, $$, api, esc, store, toast, menu, modal, confirmDialog, promptDialog, emit, on,
  KINDS, fmtDur, fmtSize, files, thumbUrl, fileUrl, copyImage, copyText, isTyping,
} from "./util.js";
import { openViewer } from "./viewer.js";
import { practiceDialog } from "./practice.js";
import { addToBoardDialog } from "./boards.js";

const PAGE = 300;
const GAP = 10;

export const state = {
  view: "all", folder: 0, tags: [], ntags: [], q: "", type: "", orient: "", minRating: 0, sort: "new",
  layout: "justified", thumb: 220,
  items: [], total: 0, loading: false,
  selected: new Set(), anchor: -1,
  allTags: [], folders: [],
};
let pos = [];          // рассчитанные позиции карточек
let reqId = 0;

// ======================================================================= запрос

export function filterParams() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (KINDS[state.view]) p.set("kind", state.view);
  if (state.view === "fav") p.set("fav", "true");
  if (state.view === "untagged") p.set("untagged", "true");
  if (state.view === "dupes") p.set("dupes", "true");
  if (state.view === "missing") p.set("missing", "true");
  if (state.folder) p.set("folder", state.folder);
  if (state.type) p.set("type", state.type);
  if (state.orient) p.set("orient", state.orient);
  if (state.minRating) p.set("min_rating", state.minRating);
  if (state.tags.length) p.set("tags", state.tags.join(","));
  if (state.ntags.length) p.set("ntags", state.ntags.join(","));
  p.set("sort", state.sort);
  return p;
}

export async function load(reset = true) {
  if (!reset && (state.loading || state.items.length >= state.total)) return;
  const my = ++reqId;
  state.loading = true;
  const p = filterParams();
  p.set("offset", reset ? 0 : state.items.length);
  p.set("limit", PAGE);
  try {
    const data = await api("/media?" + p);
    if (my !== reqId) return;
    const prevIds = new Set(state.items.map((i) => i.id));
    if (reset) {
      state.items = data.items;
      state.selected = new Set([...state.selected].filter((id) => data.items.some((i) => i.id === id)));
    } else {
      state.items.push(...data.items.filter((i) => !prevIds.has(i.id)));
    }
    state.total = data.total;
    renderGrid(reset);
    renderChips();
    renderDetails();
    persist();
  } finally {
    if (my === reqId) state.loading = false;
  }
  requestAnimationFrame(() => {
    const s = $("#sentinel").getBoundingClientRect();
    if (s.top < innerHeight + 600) load(false);
  });
}

function persist() {
  const { view, type, orient, minRating, sort, layout, thumb } = state;
  store("lib", { view, type, orient, minRating, sort, layout, thumb });
}

// ======================================================================= сетка и раскладка

function cardInner(it) {
  const media = it.thumb_state === -1
    ? `<div class="ph">${esc(it.ext.toUpperCase())}<br><small>${tr("нет превью")}</small></div>`
    : `<img decoding="async" src="${thumbUrl(it)}" alt="">`;
  return `<div class="ci${it.thumb_state === -1 ? " ready" : ""}">${media}</div>
    <i class="dot kind k-${it.kind}" title="${KINDS[it.kind]}"></i>
    ${it.rating ? `<span class="rating">${"★".repeat(it.rating)}</span>` : ""}
    ${it.favorite ? '<span class="fav">♥</span>' : ""}
    ${it.type === "video" ? `<span class="badge">▶ ${fmtDur(it.duration)}</span>` : ""}
    <span class="check">✓</span>
    <div class="label">${esc(it.name)}${it.tags.length ? `<br><small>${esc(it.tags.join(" · "))}</small>` : ""}</div>`;
}

function makeCard(it, i, animate) {
  const el = document.createElement("div");
  el.className = "card nomove" + (animate ? " enter" : "") + (state.selected.has(it.id) ? " sel" : "");
  el.dataset.id = it.id;
  el.style.setProperty("--i", i);
  el.innerHTML = cardInner(it);
  return el;
}

// ---------- виртуальная сетка: в DOM только карточки рядом с видимой областью

const cardEls = new Map();  // id → элемент карточки (только отрисованные)
let shown = new Set();      // id, которые уже появлялись — анимация входа один раз
const BUFFER = 1200;        // запас над и под экраном, px

function renderGrid(reset) {
  if (reset) {
    // карточки, которые остались в выдаче, переиспользуем — они плавно переедут на новые места
    const ids = new Set(state.items.map((i) => i.id));
    cardEls.forEach((el, id) => {
      if (!ids.has(id)) { el.remove(); cardEls.delete(id); }
      else { el.classList.remove("enter"); el.classList.toggle("sel", state.selected.has(id)); }
    });
    shown = new Set(cardEls.keys());
  }
  layout();
  updateCount();
  renderEmpty();
}

function aspect(it) {
  if (!it.width || !it.height) return 1;
  return Math.min(2.6, Math.max(0.42, it.width / it.height));
}

export function layout() {
  const grid = $("#grid");
  const W = grid.clientWidth;
  if (!W) return;
  const H = state.thumb;
  pos = [];
  let y = 0;
  if (state.layout === "grid") {
    const cols = Math.max(1, Math.floor((W + GAP) / (H + GAP)));
    const size = (W - GAP * (cols - 1)) / cols;
    state.items.forEach((_, i) => pos.push({ x: (i % cols) * (size + GAP), y: Math.floor(i / cols) * (size + GAP), w: size, h: size }));
    y = Math.ceil(state.items.length / cols) * (size + GAP);
  } else {
    let row = [], sum = 0;
    const flush = (h) => {
      let x = 0;
      row.forEach((a) => { const w = a * h; pos.push({ x, y, w, h }); x += w + GAP; });
      y += h + GAP; row = []; sum = 0;
    };
    state.items.forEach((it) => {
      const a = aspect(it);
      row.push(a); sum += a;
      if (sum * H + GAP * (row.length - 1) >= W) flush((W - GAP * (row.length - 1)) / sum);
    });
    if (row.length) flush(H);
  }
  grid.style.height = Math.max(0, y - GAP) + "px";
  const index = new Map(state.items.map((it, i) => [it.id, i]));
  cardEls.forEach((el, id) => place(el, pos[index.get(id)]));
  updateVisible();
}

function place(el, p) {
  if (!p) return;
  el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  el.style.width = p.w + "px";
  el.style.height = p.h + "px";
}

/** Первый индекс, чья карточка заканчивается ниже top (позиции отсортированы по y). */
function firstVisible(top) {
  let lo = 0, hi = pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid].y + pos[mid].h < top) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function updateVisible() {
  const wrap = $("#gridwrap"), grid = $("#grid");
  const top = wrap.scrollTop - BUFFER, bottom = wrap.scrollTop + wrap.clientHeight + BUFFER;
  const want = new Map(); // id → индекс
  for (let i = firstVisible(top); i < pos.length && pos[i].y <= bottom; i++) want.set(state.items[i].id, i);
  cardEls.forEach((el, id) => { if (!want.has(id)) { el.remove(); cardEls.delete(id); } });
  const frag = document.createDocumentFragment();
  const fresh = [];
  let n = 0;
  want.forEach((i, id) => {
    if (cardEls.has(id)) return;
    const el = makeCard(state.items[i], n++, !shown.has(id));
    place(el, pos[i]);
    cardEls.set(id, el);
    shown.add(id);
    fresh.push(el);
    frag.appendChild(el);
  });
  if (fresh.length) {
    grid.appendChild(frag);
    requestAnimationFrame(() => fresh.forEach((el) => el.classList.remove("nomove")));
  }
}

let scrollRaf = 0;
$("#gridwrap").addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateVisible(); });
}, { passive: true });

new ResizeObserver(() => layout()).observe($("#gridwrap"));

// картинка загрузилась → плавное проявление
$("#grid").addEventListener("load", (e) => {
  if (e.target.tagName === "IMG") { e.target.classList.add("loaded"); e.target.parentElement.classList.add("ready"); }
}, true);
$("#grid").addEventListener("error", (e) => {
  if (e.target.tagName === "IMG") { e.target.parentElement.classList.add("ready"); e.target.remove(); }
}, true);

function updateCount() {
  $("#countText").textContent = files(state.total) + (state.selected.size ? ` · ${tr("выбрано")} ${state.selected.size}` : "");
}

function renderEmpty() {
  const empty = $("#empty");
  empty.hidden = state.total > 0;
  if (state.total) return;
  if (!state.folders.length) {
    empty.innerHTML = `<div class="empty-state"><div class="big">🗂️</div><h2>${tr("Библиотека пока пуста")}</h2>
      <p>${tr("Добавьте папку со своими референсами, артами или уроками. Файлы останутся на месте — Refis только построит каталог.")}</p>
      <button class="primary" id="emptyAdd">＋ ${tr("Добавить папку")}</button></div>`;
    $("#emptyAdd").onclick = () => folderDialog();
  } else {
    empty.innerHTML = `<div class="empty-state"><div class="big">🔍</div><h2>${tr("Ничего не нашлось")}</h2>
      <p>${tr("Попробуйте убрать часть фильтров.")}</p><button id="emptyReset">${tr("Сбросить фильтры")}</button></div>`;
    $("#emptyReset").onclick = () => applyQuery({});
  }
}

export function updateCard(id) {
  const it = state.items.find((i) => i.id === id);
  const el = $(`.card[data-id="${id}"]`);
  if (!it || !el) return;
  const img = $("img", el);
  const wasLoaded = img?.classList.contains("loaded");
  el.innerHTML = cardInner(it);
  if (wasLoaded) { $("img", el)?.classList.add("loaded"); $(".ci", el).classList.add("ready"); }
}

export function refreshSelection() {
  $$("#grid .card").forEach((c) => c.classList.toggle("sel", state.selected.has(+c.dataset.id)));
  updateCount();
}

function select(ids, anchor) {
  state.selected = new Set(ids);
  if (anchor != null) state.anchor = anchor;
  refreshSelection();
  renderDetails();
}

// ---------- клики, двойной клик, меню

const grid = $("#grid");
grid.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card || marqueeMoved) return;
  const id = +card.dataset.id;
  const idx = state.items.findIndex((i) => i.id === id);
  if (e.shiftKey && state.anchor >= 0) {
    const [a, b] = [Math.min(state.anchor, idx), Math.max(state.anchor, idx)];
    if (!e.ctrlKey) state.selected.clear();
    for (let i = a; i <= b; i++) state.selected.add(state.items[i].id);
    refreshSelection(); renderDetails();
  } else if (e.ctrlKey || e.metaKey) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    state.anchor = idx;
    refreshSelection(); renderDetails();
  } else select([id], idx);
});
grid.addEventListener("dblclick", (e) => {
  const card = e.target.closest(".card");
  if (card) view(+card.dataset.id);
});
grid.addEventListener("contextmenu", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  e.preventDefault();
  const id = +card.dataset.id;
  if (!state.selected.has(id)) select([id], state.items.findIndex((i) => i.id === id));
  const ids = [...state.selected];
  const one = ids.length === 1;
  const it = state.items.find((i) => i.id === id);
  menu(e, [
    one && [tr("Открыть"), () => view(id), tr("Пробел")],
    one && it.type === "image" && [tr("Копировать картинку"), () => copyImage(fileUrl(id)), "Ctrl C"],
    one && [tr("Показать в проводнике"), () => api(`/media/${id}/reveal`, { method: "POST" })],
    one && [tr("Открыть в программе"), () => api(`/media/${id}/open`, { method: "POST" })],
    "-",
    [tr("На доску…"), () => addToBoardDialog(ids)],
    [tr("Тренировка по выбранным"), () => practiceDialog({ ids })],
    "-",
    [tr("В избранное"), () => bulk({ ids, favorite: true }), "F"],
    [tr("Убрать из избранного"), () => bulk({ ids, favorite: false })],
    ...Object.entries(KINDS).map(([k, v]) => [`${tr("Тип")}: ${v}`, () => bulk({ ids, kind: k })]),
  ]);
});

// ---------- превью видео при наведении

let hoverTimer = null;
grid.addEventListener("pointerover", (e) => {
  const card = e.target.closest(".card");
  if (!card || card.contains(e.relatedTarget)) return;
  const it = state.items.find((i) => i.id === +card.dataset.id);
  if (it?.type !== "video") return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!card.matches(":hover") || $("video", card)) return;
    const v = document.createElement("video");
    v.className = "preview"; v.muted = true; v.loop = true; v.playsInline = true;
    v.src = fileUrl(it.id) + (it.duration ? `#t=${(it.duration * 0.15).toFixed(1)}` : "");
    v.oncanplay = () => v.play().catch(() => {});
    $(".ci", card).appendChild(v);
  }, 380);
});
grid.addEventListener("pointerout", (e) => {
  const card = e.target.closest(".card");
  if (!card || card.contains(e.relatedTarget)) return;
  clearTimeout(hoverTimer);
  const v = $("video.preview", card);
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); v.remove(); }
});

// ---------- выделение рамкой

let marquee = null, marqueeMoved = false;
$("#gridwrap").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest(".card, button, input, .empty-state")) return;
  const wrap = $("#gridwrap"), gr = grid.getBoundingClientRect();
  marquee = {
    x0: e.clientX - gr.left, y0: e.clientY - gr.top, el: null,
    base: e.shiftKey || e.ctrlKey ? new Set(state.selected) : new Set(),
  };
  marqueeMoved = false;
  wrap.setPointerCapture(e.pointerId);
});
$("#gridwrap").addEventListener("pointermove", (e) => {
  if (!marquee) return;
  const gr = grid.getBoundingClientRect();
  const x1 = e.clientX - gr.left, y1 = e.clientY - gr.top;
  if (!marqueeMoved && Math.hypot(x1 - marquee.x0, y1 - marquee.y0) < 5) return;
  marqueeMoved = true;
  if (!marquee.el) { marquee.el = document.createElement("div"); marquee.el.className = "marquee"; grid.appendChild(marquee.el); }
  const r = { x: Math.min(marquee.x0, x1), y: Math.min(marquee.y0, y1), w: Math.abs(x1 - marquee.x0), h: Math.abs(y1 - marquee.y0) };
  Object.assign(marquee.el.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
  const sel = new Set(marquee.base);
  pos.forEach((p, i) => {
    if (p.x < r.x + r.w && p.x + p.w > r.x && p.y < r.y + r.h && p.y + p.h > r.y) sel.add(state.items[i].id);
  });
  state.selected = sel;
  refreshSelection();
  // автопрокрутка у краёв
  const wr = $("#gridwrap").getBoundingClientRect();
  if (e.clientY > wr.bottom - 40) $("#gridwrap").scrollTop += 18;
  if (e.clientY < wr.top + 40) $("#gridwrap").scrollTop -= 18;
});
$("#gridwrap").addEventListener("pointerup", () => {
  if (!marquee) return;
  marquee.el?.remove();
  if (!marqueeMoved) { state.selected.clear(); refreshSelection(); }
  renderDetails();
  marquee = null;
  setTimeout(() => (marqueeMoved = false), 0);
});

new IntersectionObserver((ents) => {
  if (ents.some((e) => e.isIntersecting)) load(false);
}, { root: $("#gridwrap"), rootMargin: "800px" }).observe($("#sentinel"));

// ======================================================================= просмотр

function view(id) {
  const card = $(`.card[data-id="${id}"]`);
  openViewer({
    items: state.items,
    total: () => state.total,
    loadMore: () => load(false),
    cardEl: (mid) => $(`.card[data-id="${mid}"]`),
    onNavigate: (mid) => {
      const idx = state.items.findIndex((i) => i.id === mid);
      select([mid], idx);
      scrollToCard(mid);
    },
    onChange: (mid) => { updateCard(mid); refreshSelection(); },
  }, id, card);
}

function scrollToCard(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  const p = pos[idx];
  if (!p) return;
  const wrap = $("#gridwrap");
  if (p.y < wrap.scrollTop) wrap.scrollTo({ top: p.y - 10, behavior: "smooth" });
  else if (p.y + p.h > wrap.scrollTop + wrap.clientHeight) wrap.scrollTo({ top: p.y + p.h - wrap.clientHeight + 30, behavior: "smooth" });
}

// ======================================================================= панель деталей

let detailsReq = 0;
export async function renderDetails() {
  const d = $("#details");
  const ids = [...state.selected];
  const my = ++detailsReq;
  if (!ids.length) {
    if (d.dataset.mode === "none") return;
    d.dataset.mode = "none";
    d.innerHTML = `<div class="placeholder">${tr("Выберите файл, чтобы увидеть детали")}<br><br>
      <small><kbd>${tr("Клик")}</kbd> ${tr("выбрать")} · <kbd>Ctrl</kbd>/<kbd>Shift</kbd> ${tr("несколько")}<br>
      <kbd>${tr("Пробел")}</kbd> ${tr("просмотр")} · <kbd>1</kbd>–<kbd>5</kbd> ${tr("оценка")} · <kbd>F</kbd> ${tr("избранное")}<br>
      <kbd>T</kbd> ${tr("добавить тег")} · <kbd>Ctrl C</kbd> ${tr("копировать")}<br>
      ${tr("Перетащите или вставьте")} (<kbd>Ctrl V</kbd>) ${tr("картинку, чтобы добавить")}</small></div>`;
    return;
  }
  if (ids.length > 1) { d.dataset.mode = "bulk"; return renderBulk(ids); }
  const id = ids[0];
  if (d.dataset.mode === "one" && +d.dataset.id === id && !d.dataset.stale) return;
  const m = await api(`/media/${id}`);
  if (my !== detailsReq) return;
  d.dataset.mode = "one"; d.dataset.id = id; delete d.dataset.stale;
  d.innerHTML = `
    <div class="dprev" title="${tr("Открыть просмотр")}"><img src="${thumbUrl(m)}" alt=""></div>
    <div><div class="dname">${esc(m.name)}<span class="muted">.${esc(m.ext)}</span></div></div>
    ${m.type === "image" ? `<div class="swatches" id="dPal" title="${tr("Палитра — клик копирует цвет")}"></div>` : ""}
    <div class="row">
      <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}" class="${n <= m.rating ? "on" : ""}">★</button>`).join("")}</div>
      <button id="dFav" class="favbtn ${m.favorite ? "on" : ""}" style="margin-left:auto">${m.favorite ? tr("♥ В избранном") : tr("♡ В избранное")}</button>
    </div>
    <div class="field"><label>${tr("Теги")}</label>${tagEditor(m.tags)}</div>
    <div class="field"><label>${tr("Тип")}</label>
      <select id="dKind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === m.kind ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    <div class="field"><label>${tr("Источник, автор, ссылка")}</label><input id="dSource" type="text" value="${esc(m.source)}" placeholder="${tr("pinterest, artstation, имя автора…")}"></div>
    <div class="field"><label>${tr("Заметки")}</label><textarea id="dNotes" placeholder="${tr("Что здесь полезного, что изучить…")}">${esc(m.notes)}</textarea></div>
    <div class="row">
      ${m.type === "image" ? `<button id="dDraw" class="primary">⏱ ${tr("Рисовать")}</button><button id="dCopy">${tr("Копировать")}</button>` : ""}
      <button id="dBoard">＋ ${tr("Доска")}</button>
    </div>
    <div class="row"><button id="dReveal">${tr("Показать в проводнике")}</button><button id="dOpen">${tr("Открыть в программе")}</button></div>
    <div class="meta">
      ${m.width ? `<span>${tr("Размер")}</span><span>${m.width}×${m.height}</span>` : ""}
      ${m.duration ? `<span>${tr("Длина")}</span><span>${fmtDur(m.duration)}</span>` : ""}
      <span>${tr("Файл")}</span><span>${fmtSize(m.size)}</span>
      <span>${tr("Изменён")}</span><span>${new Date(m.mtime * 1000).toLocaleDateString()}</span>
      ${m.view_count ? `<span>${tr("Открыт")}</span><span>${m.view_count} ${plural(m.view_count, "раз", "раза", "раз")}</span>` : ""}
      <span>${tr("Путь")}</span><span class="path">${esc(m.path)}</span>
    </div>
    ${m.duplicates?.length ? `<div class="field dups"><label>${tr("Дубликаты")} (${m.duplicates.length})</label>
      <ul class="list">${m.duplicates.map((x) => `<li data-id="${x.id}" title="${tr("Показать в проводнике")}">${esc(x.path)}</li>`).join("")}</ul></div>` : ""}
    ${m.missing ? `<p style="color:var(--danger);margin:0">${tr("Файл не найден на диске.")}</p><button class="danger" id="dForget">${tr("Убрать из каталога")}</button>` : ""}
  `;
  const save = async (patch) => {
    const upd = await api(`/media/${id}`, { method: "PATCH", body: patch });
    const it = state.items.find((i) => i.id === id);
    if (it) Object.assign(it, { kind: upd.kind, favorite: upd.favorite, rating: upd.rating, tags: upd.tags });
    updateCard(id);
    refreshSelection();
    return upd;
  };
  $(".dprev", d).onclick = () => view(id);
  if (m.type === "image") {
    api(`/media/${id}/palette`).then((pal) => {
      const el = $("#dPal");
      if (!el || my !== detailsReq) return;
      el.innerHTML = pal.map((c) => `<i style="background:${c.hex}" data-hex="${c.hex}"></i>`).join("");
      $$("i", el).forEach((i) => (i.onclick = () => copyText(i.dataset.hex, i.dataset.hex)));
    }).catch(() => {});
    $("#dDraw").onclick = () => practiceDialog({ ids: [id], single: true });
    $("#dCopy").onclick = () => copyImage(fileUrl(id));
  }
  $("#dBoard").onclick = () => addToBoardDialog([id]);
  $("#dKind").onchange = (e) => save({ kind: e.target.value });
  $$(".stars [data-r]", d).forEach((b) => (b.onclick = async () => {
    m.rating = +b.dataset.r === m.rating ? 0 : +b.dataset.r;
    $$(".stars [data-r]", d).forEach((x) => x.classList.toggle("on", +x.dataset.r <= m.rating));
    await save({ rating: m.rating });
  }));
  $("#dFav").onclick = async (e) => {
    m.favorite = m.favorite ? 0 : 1;
    e.currentTarget.classList.toggle("on", !!m.favorite);
    e.currentTarget.textContent = m.favorite ? tr("♥ В избранном") : tr("♡ В избранное");
    await save({ favorite: !!m.favorite });
  };
  bindTagEditor(d, m.tags, async (tags) => { m.tags = tags; await save({ tags }); loadTags(); });
  $("#dSource").onchange = (e) => save({ source: e.target.value });
  $("#dNotes").onchange = (e) => save({ notes: e.target.value });
  $("#dReveal").onclick = () => api(`/media/${id}/reveal`, { method: "POST" });
  $("#dOpen").onclick = () => api(`/media/${id}/open`, { method: "POST" });
  $$(".dups li", d).forEach((li) => (li.onclick = () => api(`/media/${li.dataset.id}/reveal`, { method: "POST" })));
  const f = $("#dForget");
  if (f) f.onclick = async () => { await bulk({ ids: [id], forget: true }); state.selected.clear(); renderDetails(); };
}

function renderBulk(ids) {
  const d = $("#details");
  const items = state.items.filter((i) => state.selected.has(i.id));
  const common = {};
  items.forEach((i) => i.tags.forEach((t) => (common[t] = (common[t] || 0) + 1)));
  d.innerHTML = `
    <div class="dname">${tr("Выбрано")}: ${ids.length}</div>
    <div class="field"><label>${tr("Добавить теги всем")}</label>
      <div class="tagedit"><input id="bAdd" list="tagOptions" placeholder="${tr("тег и")} Enter"></div></div>
    <div class="field"><label>${tr("Теги выбранных — × снимает со всех")}</label>
      <div class="row">${Object.entries(common).sort().map(([t, n]) =>
        `<span class="chip">${esc(t)} <small class="muted">${n}</small><button data-t="${esc(t)}">×</button></span>`).join("") || tr('<span class="hint">тегов нет</span>')}</div></div>
    <div class="field"><label>${tr("Тип")}</label>
      <select id="bKind"><option value="">— ${tr("не менять")} —</option>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="field"><label>${tr("Оценка")}</label>
      <div class="row stars">${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}">★</button>`).join("")}<button data-r="0" class="mini ghost">${tr("сброс")}</button></div></div>
    <div class="row"><button id="bFav">♥ ${tr("В избранное")}</button><button id="bUnfav">${tr("Убрать из избранного")}</button></div>
    <div class="row"><button id="bPractice" class="primary">⏱ ${tr("Тренировка")}</button><button id="bBoard">＋ ${tr("На доску")}</button></div>
    <div class="row"><button id="bForget" class="danger" title="${tr("Файлы на диске останутся")}">${tr("Убрать из каталога")}</button></div>`;
  const add = $("#bAdd");
  add.onkeydown = async (e) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();
    const t = add.value.trim();
    if (!t) return;
    await bulk({ ids, add_tags: t.split(",") });
    toast(`${tr("Тег")} «${t}» ${tr("добавлен к")} ${files(ids.length)}`);
  };
  $$(".chip button", d).forEach((b) => (b.onclick = async () => {
    const t = b.dataset.t;
    const had = items.filter((i) => i.tags.includes(t)).map((i) => i.id);
    await bulk({ ids, remove_tags: [t] });
    toast(`${tr("Тег")} «${t}» ${tr("снят с")} ${files(had.length)}`, { action: tr("Отменить"), life: 6000, onAction: () => bulk({ ids: had, add_tags: [t] }) });
  }));
  $("#bKind").onchange = (e) => e.target.value && bulk({ ids, kind: e.target.value });
  $$(".stars [data-r]", d).forEach((b) => (b.onclick = () => bulk({ ids, rating: +b.dataset.r })));
  $("#bFav").onclick = () => bulk({ ids, favorite: true });
  $("#bUnfav").onclick = () => bulk({ ids, favorite: false });
  $("#bPractice").onclick = () => practiceDialog({ ids });
  $("#bBoard").onclick = () => addToBoardDialog(ids);
  $("#bForget").onclick = () => confirmDialog(
    tr("Убрать из каталога?"),
    `${files(ids.length)} ${tr("исчезнут из Refis вместе с тегами и заметками. Сами файлы на диске останутся, а при следующем сканировании появятся снова, но уже без тегов.")}`,
    async () => { await bulk({ ids, forget: true }); state.selected.clear(); renderDetails(); }, tr("Убрать"));
}

export async function bulk(body) {
  await api("/media/bulk", { method: "POST", body });
  const keep = new Set(state.selected);
  $("#details").dataset.stale = "1";
  await Promise.all([load(true), loadTags()]);
  state.selected = new Set([...keep].filter((id) => state.items.some((i) => i.id === id)));
  refreshSelection();
  renderDetails();
}

// ---------- редактор тегов

function tagChip(t) { return `<span class="chip">${esc(t)}<button data-t="${esc(t)}">×</button></span>`; }
function tagEditor(tags) {
  return `<div class="tagedit">${tags.map(tagChip).join("")}<input list="tagOptions" placeholder="${tags.length ? "" : tr("добавить тег…")}"></div>`;
}
function bindTagEditor(root, tags, onChange) {
  const box = $(".tagedit", root);
  const input = $("input", box);
  let cur = [...tags];
  const redraw = () => {
    $$(".chip", box).forEach((c) => c.remove());
    input.insertAdjacentHTML("beforebegin", cur.map(tagChip).join(""));
    input.placeholder = cur.length ? "" : tr("добавить тег…");
  };
  box.onclick = (e) => {
    const b = e.target.closest("button[data-t]");
    if (b) { cur = cur.filter((t) => t !== b.dataset.t); redraw(); onChange(cur); }
    else input.focus();
  };
  const commit = () => {
    const vals = input.value.split(",").map((s) => s.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
    input.value = "";
    const before = cur.length;
    vals.forEach((v) => { if (!cur.includes(v)) cur.push(v); });
    if (cur.length !== before) { redraw(); onChange(cur); }
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    else if (e.key === "Backspace" && !input.value && cur.length) { cur.pop(); redraw(); onChange(cur); }
    else if (e.key === "Escape") input.blur();
  };
  input.onchange = () => { if (state.allTags.some((t) => t.name === input.value.trim().toLowerCase())) commit(); };
  input.onblur = commit;
}

// ======================================================================= боковая панель

export async function loadTags() {
  state.allTags = await api("/tags");
  $("#tagOptions").innerHTML = state.allTags.map((t) => `<option value="${esc(t.name)}">`).join("");
  renderTags();
  emit("tags-changed");
}

export function renderTags() {
  const f = $("#tagFilter").value.trim().toLowerCase();
  const names = new Set(state.allTags.map((t) => t.name));
  $("#taglist").innerHTML = state.allTags
    .filter((t) => !f || t.name.includes(f))
    .map((t) => {
      const parts = t.name.split("/");
      let depth = 0;
      for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join("/"))) depth = i;
      const label = f ? t.name : parts.slice(depth).join("/");
      const cls = state.tags.includes(t.name) ? "inc" : state.ntags.includes(t.name) ? "exc" : "";
      return `<li class="${cls}" data-tag="${esc(t.name)}" data-id="${t.id}" style="padding-left:${10 + depth * 14}px" title="${esc(t.name)} — ${tr("клик: показать, Alt+клик: исключить")}">
        <span class="name">${depth ? "└ " : "# "}${esc(label)}</span><span class="cnt">${t.count}</span></li>`;
    }).join("") || `<li class="empty">${f ? tr("нет совпадений") : tr("Тегов пока нет")}</li>`;
}

$("#tagFilter").oninput = renderTags;
$("#taglist").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-tag]");
  if (!li) return;
  toggleTag(li.dataset.tag, e.altKey);
});
export function toggleTag(t, exclude = false) {
  const inc = state.tags.includes(t), exc = state.ntags.includes(t);
  state.tags = state.tags.filter((x) => x !== t);
  state.ntags = state.ntags.filter((x) => x !== t);
  if (exclude) { if (!exc) state.ntags.push(t); } else if (!inc) state.tags.push(t);
  renderTags();
  emit("navigate", "library");
  load();
}
$("#taglist").addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li[data-tag]");
  if (!li) return;
  e.preventDefault();
  const { tag, id } = li.dataset;
  menu(e, [
    [tr("Показать только его"), () => { state.tags = [tag]; state.ntags = []; renderTags(); emit("navigate", "library"); load(); }],
    [tr("Исключить из поиска"), () => toggleTag(tag, true), tr("Alt+клик")],
    "-",
    [tr("Переименовать или объединить…"), () => promptDialog(tr("Переименовать тег"),
      tr("Если ввести имя существующего тега — теги объединятся. Вложенность через «/», например «анатомия/руки»."),
      tag, async (name) => { await api(`/tags/${id}`, { method: "PATCH", body: { name } }); state.tags = []; state.ntags = []; await loadTags(); load(); })],
    [tr("Удалить тег"), () => confirmDialog(tr("Удалить тег?"), `${tr("Тег")} «${tag}» ${tr("будет снят со всех файлов. Сами файлы не пострадают.")}`,
      async () => { await api(`/tags/${id}`, { method: "DELETE" }); state.tags = state.tags.filter((x) => x !== tag); await loadTags(); load(); }, tr("Удалить"))],
  ]);
});

export function setView(v) {
  state.view = v;
  $$("#views button").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
  emit("pill", "#views");
}
$("#views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  setView(b.dataset.view);
  state.folder = 0;
  renderFolders();
  emit("navigate", "library");
  load();
});

export async function loadFolders() {
  state.folders = await api("/folders");
  renderFolders();
  emit("folders-changed");
}
function renderFolders() {
  $("#folderlist").innerHTML = state.folders.map((f) =>
    `<li data-id="${f.id}" class="${state.folder === f.id ? "active" : ""}" title="${esc(f.path)}">
      <i class="dot k-${f.kind}"></i><span class="name">${esc(f.path)}</span><span class="cnt">${f.count}</span></li>`).join("")
    || `<li class="empty">${tr("Нажмите ＋, чтобы добавить")}</li>`;
}
$("#folderlist").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const id = +li.dataset.id;
  state.folder = state.folder === id ? 0 : id;
  renderFolders();
  emit("navigate", "library");
  load();
});
$("#folderlist").addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  const f = state.folders.find((x) => x.id === +li.dataset.id);
  menu(e, [
    [tr("Настройки папки…"), () => folderSettings(f)],
    [tr("Пересканировать"), async () => { await api(`/folders/${f.id}/scan`, { method: "POST" }); emit("poll"); }],
  ]);
});
$("#addFolder").onclick = () => folderDialog();

// ---------- сохранённые поиски

export async function loadSaved() {
  const list = await api("/saved");
  state.saved = list;
  $("#savedlist").innerHTML = list.map((s) => `<li data-id="${s.id}"><span class="name">☆ ${esc(s.name)}</span></li>`).join("")
    || `<li class="empty">${tr("Кнопка ☆ над сеткой сохранит поиск")}</li>`;
  $$("#savedlist li[data-id]").forEach((li) => {
    const s = list.find((x) => x.id === +li.dataset.id);
    li.onclick = () => { emit("navigate", "library"); applyQuery(s.query); };
    li.oncontextmenu = (e) => {
      e.preventDefault();
      menu(e, [[tr("Удалить поиск"), async () => { await api(`/saved/${s.id}`, { method: "DELETE" }); loadSaved(); }]]);
    };
  });
}
function currentQuery() {
  const { view, folder, tags, ntags, q, type, orient, minRating, sort } = state;
  return { view, folder, tags, ntags, q, type, orient, minRating, sort };
}
export function applyQuery(q) {
  Object.assign(state, { view: "all", folder: 0, tags: [], ntags: [], q: "", type: "", orient: "", minRating: 0, sort: "new" }, q);
  setView(state.view);
  syncControls();
  renderTags();
  renderFolders();
  load();
}
function syncControls() {
  $("#search").value = state.q;
  $$("#fType button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.type));
  $$("#layoutSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.layout));
  $("#fOrient").value = state.orient;
  $("#fRating").value = state.minRating;
  $("#fSort").value = state.sort;
  $("#thumbSize").value = state.thumb;
}
$("#saveSearch").onclick = () => {
  const auto = [state.q, ...state.tags.map((t) => "#" + t), ...state.ntags.map((t) => "-#" + t)].filter(Boolean).join(" ")
    || $(`#views [data-view="${state.view}"]`).textContent.trim();
  promptDialog(tr("Сохранить поиск"), tr("Он появится в боковой панели — один клик, и подборка снова перед вами."), auto,
    async (name) => { await api("/saved", { method: "POST", body: { name, query: currentQuery() } }); loadSaved(); toast(tr("Поиск сохранён")); });
};

// ---------- чипы фильтров

function renderChips() {
  const chips = [];
  state.tags.forEach((t) => chips.push(`<span class="chip">#${esc(t)}<button data-rm-tag="${esc(t)}">×</button></span>`));
  state.ntags.forEach((t) => chips.push(`<span class="chip exc">−#${esc(t)}<button data-rm-ntag="${esc(t)}">×</button></span>`));
  if (state.folder) {
    const f = state.folders.find((x) => x.id === state.folder);
    if (f) chips.push(`<span class="chip">📁 ${esc(f.path.split(/[\\/]/).pop())}<button data-rm-folder>×</button></span>`);
  }
  if (chips.length > 1) chips.push(`<button class="mini ghost" data-rm-all>${tr("Сбросить всё")}</button>`);
  const html = chips.join("");
  if ($("#chips").innerHTML !== html) $("#chips").innerHTML = html;
}
$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.rmTag !== undefined) state.tags = state.tags.filter((t) => t !== b.dataset.rmTag);
  if (b.dataset.rmNtag !== undefined) state.ntags = state.ntags.filter((t) => t !== b.dataset.rmNtag);
  if (b.dataset.rmFolder !== undefined) state.folder = 0;
  if (b.dataset.rmAll !== undefined) { state.tags = []; state.ntags = []; state.folder = 0; }
  renderTags(); renderFolders(); load();
});

// ======================================================================= тулбар

let searchTimer;
$("#search").oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 220);
};
$("#fType").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.type = b.dataset.v; syncControls(); load();
};
$("#layoutSeg").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.layout = b.dataset.v; syncControls(); layout(); persist();
};
$("#fOrient").onchange = (e) => { state.orient = e.target.value; load(); };
$("#fRating").onchange = (e) => { state.minRating = +e.target.value; load(); };
$("#fSort").onchange = (e) => { state.sort = e.target.value; load(); };
$("#thumbSize").oninput = (e) => { state.thumb = +e.target.value; layout(); persist(); };
$("#practiceBtn").onclick = () => practiceDialog(state.selected.size > 1 ? { ids: [...state.selected] } : { params: filterParams(), total: state.total });
$("#detailsToggle").onclick = toggleDetails;
export function toggleDetails() {
  document.body.classList.toggle("details-hidden");
  $("#detailsToggle").classList.toggle("on", !document.body.classList.contains("details-hidden"));
  store("detailsHidden", document.body.classList.contains("details-hidden"));
}

// ======================================================================= диалоги папок и загрузки

function kindOptions(sel) {
  return Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${v}</option>`).join("");
}

export function folderDialog(onDone = null) {
  const native = !!window.pywebview?.api?.pick_folder;
  modal(`<h2>${tr("Добавить папку")}</h2>
    <p>${tr("Refis не копирует и не перемещает файлы, а только запоминает, где они лежат, и строит каталог с превью.")}</p>
    <div class="field"><label>${tr("Папка")}</label>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="fPath" placeholder="${tr("D:\\Арт\\Референсы")}">
      ${native ? tr('<button id="fPick">Обзор…</button>') : ""}</div></div>
    <div class="field"><label>${tr("Что в ней по умолчанию")}</label><select id="fKind">${kindOptions("ref")}</select></div>
    <label class="check"><input type="checkbox" id="fAuto" checked><span>${tr("Сделать теги из названий подпапок")}<br><small class="muted">${tr("«Руки\\Мужские» → теги «руки» и «мужские»")}</small></span></label>
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="fOk">${tr("Добавить")}</button></div>`,
    (box, close) => {
      if (native) $("#fPick", box).onclick = async () => {
        const p = await window.pywebview.api.pick_folder();
        if (p) $("#fPath", box).value = p;
      };
      $("#fOk", box).onclick = async () => {
        const path = $("#fPath", box).value.trim();
        if (!path) return;
        await api("/folders", { method: "POST", body: { path, kind: $("#fKind", box).value, auto_tags: $("#fAuto", box).checked } });
        close();
        toast(tr("Папка добавлена — сканирую…"));
        await loadFolders();
        if (onDone) onDone(); else emit("navigate", "library");
        emit("poll");
      };
    });
}

function folderSettings(f) {
  modal(`<h2>${tr("Папка")}</h2><p style="word-break:break-all">${esc(f.path)}</p>
    <div class="field"><label>${tr("Тип по умолчанию")}</label><select id="sKind">${kindOptions(f.kind)}</select></div>
    <label class="check"><input type="checkbox" id="sApply"> ${tr("Применить этот тип ко всем")} ${files(f.count)} ${tr("папки")}</label>
    <label class="check"><input type="checkbox" id="sAuto"${f.auto_tags ? " checked" : ""}> ${tr("Теги из названий подпапок для новых файлов")}</label>
    <div class="actions" style="justify-content:space-between">
      <button class="danger" id="sDel">${tr("Убрать из")} Refis</button>
      <span class="row"><button data-close>${tr("Отмена")}</button><button class="primary" id="sOk">${tr("Сохранить")}</button></span>
    </div>`,
    (box, close) => {
      $("#sOk", box).onclick = async () => {
        await api(`/folders/${f.id}`, { method: "PATCH", body: {
          kind: $("#sKind", box).value, apply_kind: $("#sApply", box).checked, auto_tags: $("#sAuto", box).checked } });
        close(); await loadFolders(); load();
      };
      $("#sDel", box).onclick = () => confirmDialog(tr("Убрать папку из Refis?"),
        tr("Теги, оценки и заметки файлов этой папки будут удалены из каталога. Сами файлы на диске НЕ удаляются."),
        async () => { await api(`/folders/${f.id}`, { method: "DELETE" }); state.folder = 0; await Promise.all([loadFolders(), loadTags()]); load(); }, tr("Убрать"));
    });
}

export function uploadDialog(list) {
  if (!state.folders.length) return toast(tr("Сначала добавьте папку библиотеки"), { action: tr("Добавить"), onAction: folderDialog });
  const last = store("upload") || {};
  const fid = state.folder || last.folder || state.folders[0].id;
  const previews = list.filter((f) => f.type.startsWith("image/")).slice(0, 6).map((f) => URL.createObjectURL(f));
  modal(`<h2>${tr("Добавить")} ${files(list.length)}</h2>
    ${previews.length ? `<div class="row">${previews.map((u) => `<img src="${u}" style="width:64px;height:64px;object-fit:cover;border-radius:8px">`).join("")}</div>` : ""}
    <div class="field"><label>${tr("Папка библиотеки")}</label>
      <select id="uFolder">${state.folders.map((f) => `<option value="${f.id}"${f.id === fid ? " selected" : ""}>${esc(f.path)}</option>`).join("")}</select></div>
    <div class="field"><label>${tr("Подпапка")}</label><input type="text" id="uSub" value="${esc(last.sub ?? tr("_Входящие"))}"></div>
    <div class="field"><label>${tr("Тип")}</label><select id="uKind"><option value="">${tr("как у папки")}</option>${kindOptions("")}</select></div>
    <div class="field"><label>${tr("Теги через запятую")}</label><input type="text" id="uTags" list="tagOptions" placeholder="${tr("анатомия, руки")}"></div>
    <div class="field"><label>${tr("Источник")}</label><input type="text" id="uSrc" placeholder="${tr("необязательно")}"></div>
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="uOk">${tr("Добавить")}</button></div>`,
    (box, close) => {
      setTimeout(() => $("#uTags", box).focus(), 40);
      $("#uTags", box).onkeydown = (e) => { if (e.key === "Enter") $("#uOk", box).click(); };
      $("#uOk", box).onclick = async () => {
        const fd = new FormData();
        list.forEach((f) => fd.append("files", f, f.name));
        const folder = +$("#uFolder", box).value, sub = $("#uSub", box).value.trim();
        fd.append("folder_id", folder);
        fd.append("subdir", sub);
        fd.append("tags", $("#uTags", box).value);
        fd.append("kind", $("#uKind", box).value);
        store("upload", { folder, sub });
        $("#uOk", box).disabled = true;
        $("#uOk", box).textContent = tr("Копирую…");
        const res = await api("/upload", { method: "POST", body: fd });
        const src = $("#uSrc", box).value.trim();
        if (src) await Promise.all(res.added.map((id) => api(`/media/${id}`, { method: "PATCH", body: { source: src } })));
        close();
        previews.forEach(URL.revokeObjectURL);
        toast(`${tr("Добавлено")}: ${files(res.added.length)}`);
        emit("navigate", "library");
        setView("all"); state.sort = "new"; syncControls();
        await Promise.all([loadFolders(), loadTags()]);
        await load();
        select(res.added);
        emit("poll");
      };
    });
}

// ======================================================================= клавиатура библиотеки

export function libraryKey(e) {
  if (isTyping(e)) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const ids = [...state.selected];
  const one = ids.length === 1 ? state.items.find((i) => i.id === ids[0]) : null;
  if ((e.ctrlKey || e.metaKey) && (k === "a" || k === "ф")) {
    select(state.items.map((i) => i.id)); return true;
  }
  if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "с") && one?.type === "image") { copyImage(fileUrl(one.id)); return true; }
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (k === "Escape" && ids.length) { select([]); return true; }
  if ((k === " " || k === "Enter") && ids.length) { view(ids[0]); return true; }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k)) { arrowNav(k, e.shiftKey); return true; }
  if (ids.length && /^[0-5]$/.test(k)) { bulk({ ids, rating: +k }); toast(+k ? `${tr("Оценка")} ${"★".repeat(+k)}` : tr("Оценка сброшена")); return true; }
  if (ids.length && (k === "f" || k === "а")) {
    const fav = !state.items.filter((i) => state.selected.has(i.id)).every((i) => i.favorite);
    bulk({ ids, favorite: fav }); toast(fav ? tr("♥ В избранном") : tr("Убрано из избранного")); return true;
  }
  if (ids.length && (k === "t" || k === "е")) {
    if (document.body.classList.contains("details-hidden")) toggleDetails();
    setTimeout(() => $("#details .tagedit input")?.focus(), 50); return true;
  }
  if (k === "i" || k === "ш") { toggleDetails(); return true; }
  return false;
}

function arrowNav(k, extend) {
  if (!state.items.length) return;
  let i = state.anchor >= 0 && state.anchor < state.items.length ? state.anchor : -1;
  if (i < 0) i = 0;
  else if (k === "ArrowLeft") i = Math.max(0, i - 1);
  else if (k === "ArrowRight") i = Math.min(state.items.length - 1, i + 1);
  else {
    const p = pos[i], cx = p.x + p.w / 2;
    const dir = k === "ArrowDown" ? 1 : -1;
    let best = -1, bestD = Infinity;
    pos.forEach((q, j) => {
      const dy = (q.y - p.y) * dir;
      if (dy <= 1) return;
      const d = dy * 4 + Math.abs(q.x + q.w / 2 - cx);
      if (d < bestD) { bestD = d; best = j; }
    });
    if (best >= 0) i = best;
  }
  if (i >= state.items.length - 4) load(false);
  const id = state.items[i].id;
  if (extend) { state.selected.add(id); state.anchor = i; refreshSelection(); renderDetails(); }
  else select([id], i);
  scrollToCard(id);
}

// ======================================================================= старт

export function initLibrary() {
  const saved = store("lib") || {};
  Object.assign(state, saved);
  if (store("detailsHidden")) document.body.classList.add("details-hidden");
  $("#detailsToggle").classList.toggle("on", !document.body.classList.contains("details-hidden"));
  setView(state.view);
  syncControls();
}

on("library-reload", () => load());
