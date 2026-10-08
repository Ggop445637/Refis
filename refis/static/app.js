"use strict";

const KINDS = { ref: "Референс", own: "Моя работа", tutorial: "Туториал", other: "Прочее" };
const PAGE = 300;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem("refis." + key));
    localStorage.setItem("refis." + key, JSON.stringify(val));
  } catch { return null; }
}

async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.body && !(o.body instanceof FormData)) {
    o.body = JSON.stringify(o.body);
    o.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch("/api" + path, o);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    toast(typeof msg === "string" ? msg : "Ошибка запроса");
    throw new Error(msg);
  }
  return r.json();
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function fmtDur(s) {
  if (s == null) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}
function fmtSize(b) {
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(1) + " ГБ";
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + " МБ";
  return Math.max(1, Math.round(b / 1024)) + " КБ";
}

// ======================================================================= состояние

const state = {
  view: "all",
  folder: 0,
  tags: [],   // включённые теги из боковой панели
  ntags: [],  // исключённые
  q: "",
  type: "",
  orient: "",
  minRating: 0,
  sort: "new",
  items: [],
  total: 0,
  loading: false,
  selected: new Set(),
  anchor: -1,
  allTags: [],
  folders: [],
};

function filterParams() {
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

let reqId = 0;
async function load(reset = true) {
  if (!reset && (state.loading || state.items.length >= state.total)) return;
  const my = ++reqId;
  state.loading = true;
  const p = filterParams();
  p.set("offset", reset ? 0 : state.items.length);
  p.set("limit", PAGE);
  try {
    const data = await api("/media?" + p);
    if (my !== reqId) return;
    if (reset) {
      state.items = data.items;
      state.selected = new Set([...state.selected].filter((id) => data.items.some((i) => i.id === id)));
      $("#gridwrap").scrollTop = 0;
    } else {
      state.items.push(...data.items);
    }
    state.total = data.total;
    renderGrid(reset ? 0 : state.items.length - data.items.length);
    renderChips();
    renderDetails();
  } finally {
    if (my === reqId) state.loading = false;
  }
  // если экран ещё не заполнен — догружаем
  requestAnimationFrame(() => {
    const s = $("#sentinel").getBoundingClientRect();
    if (s.top < innerHeight + 400) load(false);
  });
}

// ======================================================================= сетка

function cardHTML(it) {
  const thumb = it.thumb_state === -1
    ? `<div class="ph">${esc(it.ext.toUpperCase())}<br>нет превью</div>`
    : `<img loading="lazy" decoding="async" src="/api/thumb/${it.id}?v=${it.thumb_state}" alt="">`;
  return `<div class="card${state.selected.has(it.id) ? " sel" : ""}" data-id="${it.id}" draggable="false">
    ${thumb}
    <i class="dot kind k-${it.kind}" title="${KINDS[it.kind]}"></i>
    ${it.favorite ? '<span class="fav">★</span>' : ""}
    ${it.type === "video" ? `<span class="badge">▶ ${fmtDur(it.duration)}</span>` : ""}
    <div class="label">${esc(it.name)}${it.tags.length ? " · " + esc(it.tags.join(", ")) : ""}</div>
  </div>`;
}

function renderGrid(from = 0) {
  const grid = $("#grid");
  const html = state.items.slice(from).map(cardHTML).join("");
  if (from === 0) grid.innerHTML = html;
  else grid.insertAdjacentHTML("beforeend", html);
  $("#countText").textContent = `${state.total} файл(ов)` + (state.selected.size ? ` · выбрано: ${state.selected.size}` : "");
  const empty = $("#empty");
  empty.hidden = state.total > 0;
  if (!state.total) {
    if (!state.folders.length) {
      empty.innerHTML = `<div>Библиотека пуста. Добавьте папку со своими референсами или работами —<br>файлы останутся на месте, Refis их только проиндексирует.</div>
        <button class="primary" onclick="folderDialog()">＋ Добавить папку</button>`;
    } else {
      empty.textContent = "Ничего не найдено по этим условиям.";
    }
  }
}

function updateCard(id) {
  const it = state.items.find((i) => i.id === id);
  const el = $(`.card[data-id="${id}"]`);
  if (it && el) el.outerHTML = cardHTML(it);
}

function refreshSelectionMarks() {
  $$(".card").forEach((c) => c.classList.toggle("sel", state.selected.has(+c.dataset.id)));
  $("#countText").textContent = `${state.total} файл(ов)` + (state.selected.size ? ` · выбрано: ${state.selected.size}` : "");
}

$("#grid").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = +card.dataset.id;
  const idx = state.items.findIndex((i) => i.id === id);
  if (e.shiftKey && state.anchor >= 0) {
    const [a, b] = [Math.min(state.anchor, idx), Math.max(state.anchor, idx)];
    if (!e.ctrlKey) state.selected.clear();
    for (let i = a; i <= b; i++) state.selected.add(state.items[i].id);
  } else if (e.ctrlKey || e.metaKey) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    state.anchor = idx;
  } else {
    state.selected = new Set([id]);
    state.anchor = idx;
  }
  refreshSelectionMarks();
  renderDetails();
});
$("#grid").addEventListener("dblclick", (e) => {
  const card = e.target.closest(".card");
  if (card) openViewer(+card.dataset.id);
});
$("#grid").addEventListener("contextmenu", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  e.preventDefault();
  const id = +card.dataset.id;
  if (!state.selected.has(id)) {
    state.selected = new Set([id]);
    state.anchor = state.items.findIndex((i) => i.id === id);
    refreshSelectionMarks();
    renderDetails();
  }
  const ids = [...state.selected];
  const single = ids.length === 1;
  menu(e, [
    single && ["Открыть просмотр", () => openViewer(id)],
    single && ["Показать в проводнике", () => api(`/media/${id}/reveal`, { method: "POST" })],
    single && ["Открыть в программе по умолчанию", () => api(`/media/${id}/open`, { method: "POST" })],
    ["В избранное", () => bulk({ ids, favorite: true })],
    ["Убрать из избранного", () => bulk({ ids, favorite: false })],
    ...Object.entries(KINDS).map(([k, v]) => [`Тип: ${v}`, () => bulk({ ids, kind: k })]),
    ["Тренировка по выбранным", () => practiceDialog(ids)],
  ]);
});

new IntersectionObserver((ents) => {
  if (ents.some((e) => e.isIntersecting)) load(false);
}, { root: $("#gridwrap"), rootMargin: "600px" }).observe($("#sentinel"));

// ======================================================================= контекстное меню

function menu(e, items) {
  const m = $("#ctxmenu");
  m.innerHTML = "";
  items.filter(Boolean).forEach(([label, fn]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { m.hidden = true; fn(); };
    m.appendChild(b);
  });
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + "px";
}
document.addEventListener("click", (e) => { if (!e.target.closest("#ctxmenu")) $("#ctxmenu").hidden = true; });

// ======================================================================= панель деталей

async function renderDetails() {
  const d = $("#details");
  const ids = [...state.selected];
  if (!ids.length) {
    d.innerHTML = `<div class="empty">Выберите файл, чтобы увидеть детали.<br><br>
      <small>Ctrl+клик / Shift+клик — выбрать несколько<br>Двойной клик — открыть просмотр<br>
      Перетащите файлы в окно, чтобы добавить их</small></div>`;
    return;
  }
  if (ids.length > 1) return renderBulk(ids);
  const id = ids[0];
  const m = await api(`/media/${id}`);
  if (state.selected.size !== 1 || !state.selected.has(id)) return;
  d.innerHTML = `
    <div class="dprev" title="Открыть просмотр"><img src="/api/thumb/${m.id}?v=${m.thumb_state}" alt=""></div>
    <div class="dname">${esc(m.name)}.${esc(m.ext)}</div>
    <div class="field"><label>Тип</label>
      <select id="dKind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === m.kind ? " selected" : ""}>${v}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Оценка</label>
      <div class="row stars">${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}" class="${n <= m.rating ? "on" : ""}">★</button>`).join("")}
        <button id="dFav" class="${m.favorite ? "on" : ""}" style="margin-left:auto;font-size:14px">${m.favorite ? "★ В избранном" : "☆ В избранное"}</button>
      </div>
    </div>
    <div class="field"><label>Теги</label>${tagEditor(m.tags)}</div>
    <div class="field"><label>Источник / автор / ссылка</label><input id="dSource" type="text" value="${esc(m.source)}"></div>
    <div class="field"><label>Заметки</label><textarea id="dNotes" placeholder="Что здесь полезного, что изучить…">${esc(m.notes)}</textarea></div>
    <div class="row">
      <button id="dReveal">Показать в проводнике</button>
      <button id="dOpen">Открыть в программе</button>
    </div>
    <div class="meta">
      ${m.width ? `<span>Размер</span><span>${m.width}×${m.height}</span>` : ""}
      ${m.duration ? `<span>Длительность</span><span>${fmtDur(m.duration)}</span>` : ""}
      <span>Файл</span><span>${fmtSize(m.size)}</span>
      <span>Изменён</span><span>${new Date(m.mtime * 1000).toLocaleString()}</span>
      <span>Путь</span><span class="path">${esc(m.path)}</span>
    </div>
    ${m.duplicates?.length ? `<div class="field dups"><label>Дубликаты (${m.duplicates.length})</label>
      <ul class="list">${m.duplicates.map((x) => `<li data-path="${esc(x.path)}" data-id="${x.id}">${esc(x.path)}</li>`).join("")}</ul></div>` : ""}
    ${m.missing ? `<p style="color:var(--danger)">Файл не найден на диске.</p>
      <button class="danger" id="dForget">Убрать из каталога</button>` : ""}
  `;
  const save = async (patch) => {
    const upd = await api(`/media/${id}`, { method: "PATCH", body: patch });
    const it = state.items.find((i) => i.id === id);
    if (it) Object.assign(it, { kind: upd.kind, favorite: upd.favorite, rating: upd.rating, tags: upd.tags });
    updateCard(id);
    if (state.selected.has(id)) refreshSelectionMarks();
    return upd;
  };
  $(".dprev", d).onclick = () => openViewer(id);
  $("#dKind").onchange = (e) => save({ kind: e.target.value });
  $$(".stars [data-r]", d).forEach((b) => (b.onclick = async () => {
    const r = +b.dataset.r === m.rating ? 0 : +b.dataset.r;
    m.rating = r;
    await save({ rating: r });
    $$(".stars [data-r]", d).forEach((x) => x.classList.toggle("on", +x.dataset.r <= r));
  }));
  $("#dFav").onclick = async (e) => {
    m.favorite = !m.favorite;
    await save({ favorite: !!m.favorite });
    e.target.classList.toggle("on", !!m.favorite);
    e.target.textContent = m.favorite ? "★ В избранном" : "☆ В избранное";
  };
  bindTagEditor(d, m.tags, async (tags) => { m.tags = tags; await save({ tags }); loadTags(); });
  $("#dSource").onchange = (e) => save({ source: e.target.value });
  $("#dNotes").onchange = (e) => save({ notes: e.target.value });
  $("#dReveal").onclick = () => api(`/media/${id}/reveal`, { method: "POST" });
  $("#dOpen").onclick = () => api(`/media/${id}/open`, { method: "POST" });
  $$(".dups li", d).forEach((li) => (li.onclick = () => api(`/media/${li.dataset.id}/reveal`, { method: "POST" })));
  const f = $("#dForget");
  if (f) f.onclick = async () => { await bulk({ ids: [id], forget: true }); state.selected.clear(); };
}

function renderBulk(ids) {
  const d = $("#details");
  const items = state.items.filter((i) => state.selected.has(i.id));
  const common = {};
  items.forEach((i) => i.tags.forEach((t) => (common[t] = (common[t] || 0) + 1)));
  d.innerHTML = `
    <div class="dname">Выбрано: ${ids.length}</div>
    <div class="field"><label>Добавить теги всем</label>
      <div class="tagedit"><input id="bAdd" list="tagOptions" placeholder="тег, Enter"></div></div>
    <div class="field"><label>Теги у выбранных (× — снять со всех)</label>
      <div class="row">${Object.entries(common).sort().map(([t, n]) =>
        `<span class="chip">${esc(t)} <small style="color:var(--muted)">${n}</small><button data-t="${esc(t)}">×</button></span>`).join("") || '<span class="hint">нет тегов</span>'}</div></div>
    <div class="field"><label>Тип</label>
      <select id="bKind"><option value="">— не менять —</option>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="field"><label>Оценка</label>
      <div class="row stars">${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}">★</button>`).join("")}<button data-r="0" style="font-size:13px">сброс</button></div></div>
    <div class="row">
      <button id="bFav">★ В избранное</button>
      <button id="bUnfav">Убрать из избранного</button>
    </div>
    <div class="row">
      <button id="bPractice">⏱ Тренировка по выбранным</button>
    </div>
    <div class="row">
      <button id="bForget" class="danger" title="Файлы на диске останутся">Убрать из каталога</button>
    </div>`;
  const add = $("#bAdd");
  add.onkeydown = async (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const t = add.value.trim();
      if (!t) return;
      await bulk({ ids, add_tags: t.split(",") });
      toast(`Тег «${t}» добавлен к ${ids.length} файлам`);
    }
  };
  $$(".chip button", d).forEach((b) => (b.onclick = () => bulk({ ids, remove_tags: [b.dataset.t] })));
  $("#bKind").onchange = (e) => e.target.value && bulk({ ids, kind: e.target.value });
  $$(".stars [data-r]", d).forEach((b) => (b.onclick = () => bulk({ ids, rating: +b.dataset.r })));
  $("#bFav").onclick = () => bulk({ ids, favorite: true });
  $("#bUnfav").onclick = () => bulk({ ids, favorite: false });
  $("#bPractice").onclick = () => practiceDialog(ids);
  $("#bForget").onclick = () => confirmDialog(
    "Убрать из каталога?",
    `${ids.length} файл(ов) исчезнут из Refis вместе с тегами и заметками. Сами файлы на диске останутся. При следующем сканировании папки они появятся снова (без тегов).`,
    async () => { await bulk({ ids, forget: true }); state.selected.clear(); },
  );
}

async function bulk(body) {
  await api("/media/bulk", { method: "POST", body });
  const keep = new Set(state.selected);
  await Promise.all([load(true), loadTags()]);
  state.selected = new Set([...keep].filter((id) => state.items.some((i) => i.id === id)));
  refreshSelectionMarks();
  renderDetails();
}

// ---------- редактор тегов

function tagEditor(tags) {
  return `<div class="tagedit">${tags.map((t) => `<span class="chip">${esc(t)}<button data-t="${esc(t)}">×</button></span>`).join("")}
    <input list="tagOptions" placeholder="${tags.length ? "" : "добавить тег…"}"></div>`;
}

function bindTagEditor(root, tags, onChange) {
  const box = $(".tagedit", root);
  const input = $("input", box);
  let cur = [...tags];
  const redraw = () => {
    $$(".chip", box).forEach((c) => c.remove());
    input.insertAdjacentHTML("beforebegin", cur.map((t) => `<span class="chip">${esc(t)}<button data-t="${esc(t)}">×</button></span>`).join(""));
    input.placeholder = cur.length ? "" : "добавить тег…";
  };
  box.onclick = (e) => {
    const b = e.target.closest("button[data-t]");
    if (b) {
      cur = cur.filter((t) => t !== b.dataset.t);
      redraw();
      onChange(cur);
    } else input.focus();
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
  };
  input.onchange = () => { if (state.allTags.some((t) => t.name === input.value.trim().toLowerCase())) commit(); };
  input.onblur = commit;
}

// ======================================================================= боковая панель

async function loadTags() {
  state.allTags = await api("/tags");
  $("#tagOptions").innerHTML = state.allTags.map((t) => `<option value="${esc(t.name)}">`).join("");
  renderTags();
}

function renderTags() {
  const f = $("#tagFilter").value.trim().toLowerCase();
  const names = new Set(state.allTags.map((t) => t.name));
  $("#taglist").innerHTML = state.allTags
    .filter((t) => !f || t.name.includes(f))
    .map((t) => {
      const parts = t.name.split("/");
      // показываем вложенность только если родительский тег существует
      let depth = 0;
      for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join("/"))) depth = i;
      const label = f ? t.name : parts.slice(depth).join("/");
      const cls = state.tags.includes(t.name) ? "inc" : state.ntags.includes(t.name) ? "exc" : "";
      return `<li class="${cls}" data-tag="${esc(t.name)}" data-id="${t.id}" style="padding-left:${8 + depth * 14}px" title="${esc(t.name)}">
        <span class="name">${depth ? "└ " : "# "}${esc(label)}</span><span class="cnt">${t.count}</span></li>`;
    }).join("") || `<li class="hint" style="cursor:default">${f ? "нет совпадений" : "Тегов пока нет"}</li>`;
}

$("#tagFilter").oninput = renderTags;
$("#taglist").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-tag]");
  if (!li) return;
  const t = li.dataset.tag;
  const inc = state.tags.includes(t), exc = state.ntags.includes(t);
  state.tags = state.tags.filter((x) => x !== t);
  state.ntags = state.ntags.filter((x) => x !== t);
  if (e.altKey) { if (!exc) state.ntags.push(t); }
  else if (!inc) state.tags.push(t);
  renderTags();
  load();
});
$("#taglist").addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li[data-tag]");
  if (!li) return;
  e.preventDefault();
  const { tag, id } = li.dataset;
  menu(e, [
    ["Исключить из поиска", () => { state.tags = state.tags.filter((x) => x !== tag); if (!state.ntags.includes(tag)) state.ntags.push(tag); renderTags(); load(); }],
    ["Переименовать / объединить…", () => promptDialog("Переименовать тег",
      "Если указать имя существующего тега — теги объединятся. Используйте «/» для вложенности, например «анатомия/руки».",
      tag, async (name) => { await api(`/tags/${id}`, { method: "PATCH", body: { name } }); state.tags = []; state.ntags = []; await loadTags(); load(); })],
    ["Удалить тег", () => confirmDialog("Удалить тег?", `Тег «${tag}» будет снят со всех файлов. Файлы не удаляются.`,
      async () => { await api(`/tags/${id}`, { method: "DELETE" }); state.tags = state.tags.filter((x) => x !== tag); await loadTags(); load(); })],
  ]);
});

$("#views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  setView(b.dataset.view);
  state.folder = 0;
  renderFolders();
  load();
});
function setView(v) {
  state.view = v;
  $$("#views button").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
}

async function loadFolders() {
  state.folders = await api("/folders");
  renderFolders();
}
function renderFolders() {
  $("#folderlist").innerHTML = state.folders.map((f) =>
    `<li data-id="${f.id}" class="${state.folder === f.id ? "active" : ""}" title="${esc(f.path)}">
      <i class="dot k-${f.kind}"></i><span class="name">${esc(f.path)}</span><span class="cnt">${f.count}</span></li>`).join("")
    || `<li class="hint" style="cursor:default">Нет папок</li>`;
}
$("#folderlist").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const id = +li.dataset.id;
  state.folder = state.folder === id ? 0 : id;
  renderFolders();
  load();
});
$("#folderlist").addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  const f = state.folders.find((x) => x.id === +li.dataset.id);
  menu(e, [
    ["Настройки папки…", () => folderSettings(f)],
    ["Пересканировать", async () => { await api(`/folders/${f.id}/scan`, { method: "POST" }); pollStatus(); }],
  ]);
});
$("#addFolder").onclick = () => folderDialog();

// ---------- сохранённые поиски

async function loadSaved() {
  const list = await api("/saved");
  $("#saved").innerHTML = list.map((s) => `<li data-id="${s.id}"><span class="name">☆ ${esc(s.name)}</span></li>`).join("")
    || `<li class="hint" style="cursor:default">Нажмите «☆ Сохранить» над сеткой</li>`;
  $$("#saved li[data-id]").forEach((li) => {
    const s = list.find((x) => x.id === +li.dataset.id);
    li.onclick = () => applyQuery(s.query);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      menu(e, [["Удалить поиск", async () => { await api(`/saved/${s.id}`, { method: "DELETE" }); loadSaved(); }]]);
    };
  });
}
function currentQuery() {
  const { view, folder, tags, ntags, q, type, orient, minRating, sort } = state;
  return { view, folder, tags, ntags, q, type, orient, minRating, sort };
}
function applyQuery(q) {
  Object.assign(state, { view: "all", folder: 0, tags: [], ntags: [], q: "", type: "", orient: "", minRating: 0, sort: "new" }, q);
  setView(state.view);
  $("#search").value = state.q;
  $("#fType").value = state.type;
  $("#fOrient").value = state.orient;
  $("#fRating").value = state.minRating;
  $("#fSort").value = state.sort;
  renderTags();
  renderFolders();
  load();
}
$("#saveSearch").onclick = () => {
  const auto = [state.q, ...state.tags.map((t) => "#" + t), ...state.ntags.map((t) => "-#" + t)].filter(Boolean).join(" ")
    || $(`#views [data-view="${state.view}"]`).textContent.trim();
  promptDialog("Сохранить поиск", "Поиск появится в боковой панели — один клик, и подборка снова перед вами.", auto,
    async (name) => { await api("/saved", { method: "POST", body: { name, query: currentQuery() } }); loadSaved(); toast("Поиск сохранён"); });
};

// ---------- чипы активных фильтров

function renderChips() {
  const chips = [];
  state.tags.forEach((t) => chips.push(`<span class="chip">#${esc(t)}<button data-rm-tag="${esc(t)}">×</button></span>`));
  state.ntags.forEach((t) => chips.push(`<span class="chip exc">−#${esc(t)}<button data-rm-ntag="${esc(t)}">×</button></span>`));
  if (state.folder) {
    const f = state.folders.find((x) => x.id === state.folder);
    if (f) chips.push(`<span class="chip">📁 ${esc(f.path.split(/[\\/]/).pop())}<button data-rm-folder>×</button></span>`);
  }
  if (chips.length > 1) chips.push(`<button class="mini ghost" data-rm-all>Сбросить всё</button>`);
  $("#chips").innerHTML = chips.join("");
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
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250);
};
$("#fType").onchange = (e) => { state.type = e.target.value; load(); };
$("#fOrient").onchange = (e) => { state.orient = e.target.value; load(); };
$("#fRating").onchange = (e) => { state.minRating = +e.target.value; load(); };
$("#fSort").onchange = (e) => { state.sort = e.target.value; store("sort", state.sort); load(); };
$("#thumbSize").oninput = (e) => {
  document.documentElement.style.setProperty("--thumb", e.target.value + "px");
  store("thumb", +e.target.value);
};
$("#fitToggle").onclick = () => {
  document.body.classList.toggle("fit-contain");
  store("contain", document.body.classList.contains("fit-contain"));
};
$("#practiceBtn").onclick = () => practiceDialog(state.selected.size > 1 ? [...state.selected] : null);

// ======================================================================= диалоги

function modal(html, onReady) {
  const m = $("#modal");
  $(".mbox", m).innerHTML = html;
  m.hidden = false;
  const close = () => { m.hidden = true; };
  $$("[data-close]", m).forEach((b) => (b.onclick = close));
  onReady?.($(".mbox", m), close);
  $("input[type=text], select, input", m)?.focus();
}
$("#modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });

function confirmDialog(title, text, onOk) {
  modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="mOk">Да</button></div>`,
    (box, close) => { $("#mOk", box).onclick = async () => { close(); await onOk(); }; });
}

function promptDialog(title, text, value, onOk) {
  modal(`<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ""}<input type="text" id="mVal" value="${esc(value)}">
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="mOk">ОК</button></div>`,
    (box, close) => {
      const ok = async () => { const v = $("#mVal", box).value.trim(); if (!v) return; close(); await onOk(v); };
      $("#mOk", box).onclick = ok;
      $("#mVal", box).onkeydown = (e) => e.key === "Enter" && ok();
      setTimeout(() => $("#mVal", box).select(), 0);
    });
}

function kindOptions(sel) {
  return Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${v}</option>`).join("");
}

function folderDialog() {
  const native = !!window.pywebview?.api?.pick_folder;
  modal(`<h2>Добавить папку</h2>
    <p>Refis не копирует и не перемещает файлы — только запоминает, где они лежат, и строит каталог с превью.</p>
    <div class="field"><label>Путь к папке</label>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="fPath" placeholder="D:\\Арт\\Референсы">
      ${native ? '<button id="fPick">Обзор…</button>' : ""}</div></div>
    <div class="field"><label>Что в этой папке по умолчанию</label><select id="fKind">${kindOptions("ref")}</select></div>
    <label class="check"><input type="checkbox" id="fAuto" checked> Превратить названия подпапок в теги
      <small style="color:var(--muted)">(«Руки\\Мужские» → теги «руки», «мужские»)</small></label>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="fOk">Добавить</button></div>`,
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
        toast("Папка добавлена, идёт сканирование…");
        await loadFolders();
        pollStatus();
      };
    });
}

function folderSettings(f) {
  modal(`<h2>Папка</h2><p style="word-break:break-all">${esc(f.path)}</p>
    <div class="field"><label>Тип по умолчанию для новых файлов</label><select id="sKind">${kindOptions(f.kind)}</select></div>
    <label class="check"><input type="checkbox" id="sApply"> Применить этот тип ко всем ${f.count} файлам папки</label>
    <label class="check"><input type="checkbox" id="sAuto"${f.auto_tags ? " checked" : ""}> Теги из названий подпапок (для новых файлов)</label>
    <div class="actions" style="justify-content:space-between">
      <button class="danger" id="sDel">Убрать папку из Refis</button>
      <span class="row"><button data-close>Отмена</button><button class="primary" id="sOk">Сохранить</button></span>
    </div>`,
    (box, close) => {
      $("#sOk", box).onclick = async () => {
        await api(`/folders/${f.id}`, { method: "PATCH", body: {
          kind: $("#sKind", box).value, apply_kind: $("#sApply", box).checked, auto_tags: $("#sAuto", box).checked } });
        close(); await loadFolders(); load();
      };
      $("#sDel", box).onclick = () => confirmDialog("Убрать папку из Refis?",
        "Все теги, оценки и заметки для файлов этой папки будут удалены из каталога. Сами файлы на диске НЕ удаляются.",
        async () => { await api(`/folders/${f.id}`, { method: "DELETE" }); state.folder = 0; await Promise.all([loadFolders(), loadTags()]); load(); });
    });
}

// ======================================================================= просмотр

const viewer = {
  id: null, mirror: false, gray: false, blur: false, loop: true,
  scale: 1, x: 0, y: 0, natW: 0, natH: 0, el: null,
};

function openViewer(id) {
  viewer.id = id;
  $("#viewer").hidden = false;
  showInViewer();
}

function showInViewer() {
  const it = state.items.find((i) => i.id === viewer.id);
  if (!it) return closeViewer();
  const stage = $("#vStage");
  stage.innerHTML = "";
  stage.className = "stage" + (viewer.gray ? " gray" : "") + (viewer.blur ? " blur" : "");
  $("#viewer").classList.toggle("is-video", it.type === "video");
  $("#vTitle").textContent = `${state.items.indexOf(it) + 1} / ${state.total} · ${it.name}.${it.ext}` + (it.tags.length ? "  ·  " + it.tags.join(", ") : "");
  $('[data-act="fav"]').textContent = it.favorite ? "★" : "☆";
  syncViewerButtons();
  let el;
  if (it.type === "video") {
    el = document.createElement("video");
    el.src = `/api/file/${it.id}`;
    el.controls = false;
    el.autoplay = true;
    el.muted = !!store("muted");
    bindVideoBar(el);
    el.loop = viewer.loop;
    el.playbackRate = +$("#vSpeed").value;
    el.onloadedmetadata = () => { viewer.natW = el.videoWidth; viewer.natH = el.videoHeight; fitView(); };
    el.onerror = () => {
      stage.innerHTML = `<div style="text-align:center;color:var(--muted)">Этот формат видео не поддерживается встроенным плеером.<br><br>
        <button onclick="api('/media/${it.id}/open',{method:'POST'})">Открыть в системном плеере</button></div>`;
    };
  } else {
    el = new Image();
    el.src = `/api/file/${it.id}`;
    el.onload = () => { viewer.natW = el.naturalWidth; viewer.natH = el.naturalHeight; fitView(); };
    el.onerror = () => { el.src = `/api/thumb/${it.id}`; };
    el.draggable = false;
  }
  viewer.el = el;
  el.style.visibility = "hidden";
  stage.appendChild(el);
}

function fitView() {
  const stage = $("#vStage").getBoundingClientRect();
  const s = Math.min(stage.width / viewer.natW, stage.height / viewer.natH, viewer.el.tagName === "VIDEO" ? 4 : 1.5);
  viewer.scale = s;
  viewer.x = (stage.width - viewer.natW * s) / 2;
  viewer.y = (stage.height - viewer.natH * s) / 2;
  applyTransform();
  viewer.el.style.visibility = "";
}

function applyTransform() {
  const { el, scale, x, y, natW, natH, mirror } = viewer;
  if (!el) return;
  el.style.width = natW + "px";
  el.style.height = natH + "px";
  el.style.transform = `translate(${x}px, ${y}px) scale(${scale})` + (mirror ? ` translateX(${natW}px) scaleX(-1)` : "");
}

function syncViewerButtons() {
  $('[data-act="mirror"]').classList.toggle("on", viewer.mirror);
  $('[data-act="gray"]').classList.toggle("on", viewer.gray);
  $('[data-act="blur"]').classList.toggle("on", viewer.blur);
  $('[data-act="loop"]').classList.toggle("on", viewer.loop);
}

function closeViewer() {
  $("#viewer").hidden = true;
  $("#vStage").innerHTML = "";
  viewer.el = null;
}

function viewerStep(d) {
  const idx = state.items.findIndex((i) => i.id === viewer.id);
  const n = idx + d;
  if (n < 0) return;
  if (n >= state.items.length) { if (state.items.length < state.total) load(false); return; }
  viewer.id = state.items[n].id;
  state.selected = new Set([viewer.id]);
  state.anchor = n;
  refreshSelectionMarks();
  showInViewer();
}

async function viewerAct(act) {
  const v = viewer.el?.tagName === "VIDEO" ? viewer.el : null;
  switch (act) {
    case "close": return closeViewer();
    case "prev": return viewerStep(-1);
    case "next": return viewerStep(1);
    case "mirror": viewer.mirror = !viewer.mirror; applyTransform(); break;
    case "gray": viewer.gray = !viewer.gray; $("#vStage").classList.toggle("gray", viewer.gray); break;
    case "blur": viewer.blur = !viewer.blur; $("#vStage").classList.toggle("blur", viewer.blur); break;
    case "fit": if (viewer.el) fitView(); break;
    case "loop": viewer.loop = !viewer.loop; if (v) v.loop = viewer.loop; break;
    case "back": if (v) { v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / 30); } break;
    case "fwd": if (v) { v.pause(); v.currentTime += 1 / 30; } break;
    case "fav": {
      const it = state.items.find((i) => i.id === viewer.id);
      it.favorite = it.favorite ? 0 : 1;
      await api(`/media/${it.id}`, { method: "PATCH", body: { favorite: !!it.favorite } });
      $('[data-act="fav"]').textContent = it.favorite ? "★" : "☆";
      updateCard(it.id);
      refreshSelectionMarks();
      break;
    }
  }
  syncViewerButtons();
}

$("#viewer").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (b) viewerAct(b.dataset.act);
});
$("#vSpeed").onchange = (e) => { if (viewer.el?.tagName === "VIDEO") viewer.el.playbackRate = +e.target.value; };

// зум колесом относительно курсора и перетаскивание
$("#vStage").addEventListener("wheel", (e) => {
  if (!viewer.el) return;
  e.preventDefault();
  const r = $("#vStage").getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.exp(-e.deltaY * 0.0015);
  const ns = Math.min(20, Math.max(0.05, viewer.scale * k));
  viewer.x = mx - (mx - viewer.x) * (ns / viewer.scale);
  viewer.y = my - (my - viewer.y) * (ns / viewer.scale);
  viewer.scale = ns;
  applyTransform();
}, { passive: false });
let drag = null;
$("#vStage").addEventListener("mousedown", (e) => {
  if (!viewer.el || e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, ox: viewer.x, oy: viewer.y, moved: false };
  e.preventDefault();
});
addEventListener("mousemove", (e) => {
  if (!drag) return;
  viewer.x = drag.ox + e.clientX - drag.x;
  viewer.y = drag.oy + e.clientY - drag.y;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
  applyTransform();
});
let lastDragMoved = false;
addEventListener("mouseup", () => { if (drag) lastDragMoved = drag.moved; drag = null; });
$("#vStage").addEventListener("dblclick", () => viewer.el && fitView());
// клик без перетаскивания по видео — пауза/пуск
$("#vStage").addEventListener("click", () => {
  const v = viewer.el?.tagName === "VIDEO" ? viewer.el : null;
  if (v && !lastDragMoved) v.paused ? v.play() : v.pause();
});

function bindVideoBar(v) {
  const seek = $("#vSeek"), play = $("#vPlay"), time = $("#vTime"), mute = $("#vMute");
  const upd = () => {
    if (!seek.matches(":active")) seek.value = v.duration ? (1000 * v.currentTime) / v.duration : 0;
    time.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
    play.textContent = v.paused ? "▶" : "❚❚";
    mute.textContent = v.muted ? "🔇" : "🔊";
  };
  ["timeupdate", "play", "pause", "loadedmetadata", "volumechange", "seeked"].forEach((ev) => v.addEventListener(ev, upd));
  seek.oninput = () => { if (v.duration) v.currentTime = (seek.value / 1000) * v.duration; };
  play.onclick = () => (v.paused ? v.play() : v.pause());
  mute.onclick = () => { v.muted = !v.muted; store("muted", v.muted); };
  upd();
}
function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}
addEventListener("resize", () => { if (!$("#viewer").hidden && viewer.el) fitView(); });

// ======================================================================= тренировка

const practice = { list: [], i: 0, dur: 60, left: 0, paused: false, timer: null, mirror: false, gray: false, done: 0 };

async function practiceDialog(ids) {
  const last = store("practice") || { dur: 60, count: 20, shuffle: true };
  const presets = [[30, "30 сек"], [60, "1 мин"], [120, "2 мин"], [300, "5 мин"], [600, "10 мин"], [0, "Без таймера"]];
  modal(`<h2>Тренировка набросков</h2>
    <p>${ids ? `Источник: выбранные файлы (${ids.length}).` : `Источник: текущая подборка (${state.total} файлов, видео пропускаются).`}</p>
    <div class="field"><label>Время на одну картинку</label>
      <div class="opts">${presets.map(([s, l]) => `<button data-d="${s}" class="${s === last.dur ? "on" : ""}">${l}</button>`).join("")}
        <input type="number" id="pCustom" min="5" placeholder="свои, сек" style="width:110px"></div></div>
    <div class="field"><label>Сколько картинок</label><input type="number" id="pCount" min="1" value="${last.count}" style="width:110px"></div>
    <label class="check"><input type="checkbox" id="pShuffle"${last.shuffle ? " checked" : ""}> Перемешать</label>
    <label class="check"><input type="checkbox" id="pMirror"> Отзеркалить</label>
    <label class="check"><input type="checkbox" id="pGray"> Чёрно-белое</label>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="pGo">Начать</button></div>`,
    (box, close) => {
      let dur = last.dur;
      $$("[data-d]", box).forEach((b) => (b.onclick = () => {
        dur = +b.dataset.d;
        $$("[data-d]", box).forEach((x) => x.classList.toggle("on", x === b));
        $("#pCustom", box).value = "";
      }));
      $("#pGo", box).onclick = async () => {
        const custom = +$("#pCustom", box).value;
        if (custom > 0) dur = custom;
        const count = Math.max(1, +$("#pCount", box).value || 20);
        const shuffle = $("#pShuffle", box).checked;
        store("practice", { dur, count, shuffle });
        let list;
        if (ids) {
          list = state.items.filter((i) => ids.includes(i.id) && i.type === "image").map((i) => i.id);
        } else {
          const p = filterParams();
          p.set("type", "image");
          if (shuffle) p.set("sort", "random");
          p.set("limit", 2000);
          list = (await api("/media?" + p)).items.map((i) => i.id);
        }
        if (shuffle) list.sort(() => Math.random() - 0.5);
        list = list.slice(0, count);
        if (!list.length) return toast("В подборке нет картинок");
        close();
        Object.assign(practice, { list, i: 0, dur, paused: false, done: 0,
          mirror: $("#pMirror", box).checked, gray: $("#pGray", box).checked });
        $("#practice").hidden = false;
        practiceShow();
        clearInterval(practice.timer);
        practice.timer = setInterval(practiceTick, 250);
      };
    });
}

function practiceShow() {
  const id = practice.list[practice.i];
  const stage = $("#pStage");
  stage.className = "stage" + (practice.gray ? " gray" : "");
  stage.innerHTML = "";
  const img = new Image();
  img.src = `/api/file/${id}`;
  img.style.cssText = "position:static;max-width:100%;max-height:100%;object-fit:contain;transform:" + (practice.mirror ? "scaleX(-1)" : "none");
  stage.appendChild(img);
  practice.left = practice.dur;
  practice.started = performance.now();
  $("#pCounter").textContent = `${practice.i + 1} / ${practice.list.length}`;
  $('[data-p="pause"]').textContent = practice.paused ? "▶" : "❚❚";
  $('[data-p="mirror"]').classList.toggle("on", practice.mirror);
  $('[data-p="gray"]').classList.toggle("on", practice.gray);
  practiceRenderTime();
  // предзагрузка следующей
  const next = practice.list[practice.i + 1];
  if (next) new Image().src = `/api/file/${next}`;
}

let lastTick = 0;
function practiceTick() {
  const now = performance.now();
  const dt = lastTick ? (now - lastTick) / 1000 : 0;
  lastTick = now;
  if (practice.paused || !practice.dur) { practiceRenderTime(); return; }
  practice.left -= Math.min(dt, 1);
  if (practice.left <= 0) {
    practice.done++;
    if (practice.i + 1 >= practice.list.length) return practiceEnd();
    practice.i++;
    practiceShow();
  }
  practiceRenderTime();
}
function practiceRenderTime() {
  if (!practice.dur) { $("#pTime").textContent = "∞"; $("#pProgress").style.width = "0"; return; }
  const s = Math.max(0, Math.ceil(practice.left));
  $("#pTime").textContent = fmtDur(s);
  $("#pProgress").style.width = (100 * (1 - practice.left / practice.dur)) + "%";
}
function practiceEnd(early = false) {
  clearInterval(practice.timer);
  lastTick = 0;
  const total = early ? practice.i : practice.list.length;
  $("#pStage").innerHTML = `<div class="pdone"><h2>Готово!</h2><p>Набросков: ${total}${practice.dur ? ` · по ${fmtDur(practice.dur)}` : ""}</p><br>
    <button class="primary" onclick="$('#practice').hidden=true">Закрыть</button></div>`;
  $("#pTime").textContent = "";
  $("#pProgress").style.width = "100%";
}
function practiceAct(a) {
  switch (a) {
    case "prev": if (practice.i > 0) { practice.i--; practiceShow(); } break;
    case "next": if (practice.i + 1 < practice.list.length) { practice.i++; practice.done++; practiceShow(); } else practiceEnd(); break;
    case "pause": practice.paused = !practice.paused; $('[data-p="pause"]').textContent = practice.paused ? "▶" : "❚❚"; break;
    case "mirror": practice.mirror = !practice.mirror; practiceShow(); break;
    case "gray": practice.gray = !practice.gray; $("#pStage").classList.toggle("gray", practice.gray); $('[data-p="gray"]').classList.toggle("on", practice.gray); break;
    case "stop":
      if (practice.timer && $("#pStage img")) { practiceEnd(true); }
      else $("#practice").hidden = true;
      break;
  }
}
$("#practice").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) practiceAct(b.dataset.p); });

// ======================================================================= перетаскивание файлов

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#dropzone").hidden = false; } });
addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("#dropzone").hidden = true; } });
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#dropzone").hidden = true;
  const files = [...e.dataTransfer.files].filter((f) => /\.(jpe?g|jfif|png|gif|webp|bmp|tiff?|psd|mp4|webm|mov|m4v|mkv|avi|wmv|flv|mpe?g)$/i.test(f.name));
  if (!files.length) return toast("Нет подходящих файлов (картинки или видео)");
  uploadDialog(files);
});

function uploadDialog(files) {
  if (!state.folders.length) return toast("Сначала добавьте хотя бы одну папку библиотеки");
  const last = store("upload") || {};
  const fid = state.folder || last.folder || state.folders[0].id;
  modal(`<h2>Добавить ${files.length} файл(ов)</h2>
    <p>Файлы будут скопированы в выбранную папку библиотеки.</p>
    <div class="field"><label>Папка библиотеки</label>
      <select id="uFolder">${state.folders.map((f) => `<option value="${f.id}"${f.id === fid ? " selected" : ""}>${esc(f.path)}</option>`).join("")}</select></div>
    <div class="field"><label>Подпапка</label><input type="text" id="uSub" value="${esc(last.sub ?? "_Входящие")}"></div>
    <div class="field"><label>Тип</label><select id="uKind"><option value="">как у папки</option>${kindOptions("")}</select></div>
    <div class="field"><label>Теги (через запятую)</label><input type="text" id="uTags" list="tagOptions" placeholder="например: анатомия, руки"></div>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="uOk">Добавить</button></div>`,
    (box, close) => {
      $("#uOk", box).onclick = async () => {
        const fd = new FormData();
        files.forEach((f) => fd.append("files", f, f.name));
        const folder = +$("#uFolder", box).value, sub = $("#uSub", box).value.trim();
        fd.append("folder_id", folder);
        fd.append("subdir", sub);
        fd.append("tags", $("#uTags", box).value);
        fd.append("kind", $("#uKind", box).value);
        store("upload", { folder, sub });
        $("#uOk", box).disabled = true;
        $("#uOk", box).textContent = "Копирую…";
        const res = await api("/upload", { method: "POST", body: fd });
        close();
        toast(`Добавлено: ${res.added.length}`);
        setView("all"); state.sort = "new"; $("#fSort").value = "new";
        await Promise.all([loadFolders(), loadTags()]);
        await load();
        state.selected = new Set(res.added);
        refreshSelectionMarks();
        renderDetails();
        pollStatus();
      };
    });
}

// ======================================================================= статус сканирования

let pollTimer = null, wasBusy = false;
async function pollStatus() {
  clearTimeout(pollTimer);
  const s = await api("/status").catch(() => null);
  if (!s) return;
  $('[data-count="all"]').textContent = s.total - (s.missing || 0);
  const busy = s.scan.running || s.thumbs_pending > 0;
  let text = "";
  if (s.scan.running) text = `Сканирование… найдено новых: ${s.scan.added}`;
  else if (s.thumbs_pending) text = `Создание превью… осталось ${s.thumbs_pending}`;
  if (!s.ffmpeg) text += (text ? " · " : "") + "ffmpeg не найден — превью видео недоступны";
  $("#scanText").textContent = text;
  if (busy) {
    pollTimer = setTimeout(pollStatus, 1500);
    // по ходу сканирования обновляем сетку, чтобы файлы появлялись сразу
    if (s.scan.running && !state.selected.size && $("#gridwrap").scrollTop < 50) { loadFolders(); load(); }
  }
  if (wasBusy && !busy) { loadFolders(); loadTags(); load(); }
  if (!busy) pollTimer = setTimeout(pollStatus, 15000);
  wasBusy = busy;
}

// ======================================================================= клавиатура

addEventListener("keydown", (e) => {
  const typing = e.target.matches("input, textarea, select");
  if (!$("#modal").hidden) { if (e.key === "Escape") $("#modal").hidden = true; return; }
  if (!$("#practice").hidden) {
    const map = { ArrowLeft: "prev", ArrowRight: "next", " ": "pause", h: "mirror", "р": "mirror", g: "gray", "п": "gray", Escape: "stop" };
    const a = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (a) { e.preventDefault(); practiceAct(a); }
    return;
  }
  if (!$("#viewer").hidden) {
    if (typing) return;
    const v = viewer.el?.tagName === "VIDEO" ? viewer.el : null;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = { Escape: "close", ArrowLeft: "prev", ArrowRight: "next", h: "mirror", "р": "mirror", g: "gray", "п": "gray",
      b: "blur", "и": "blur", f: "fav", "а": "fav", "0": "fit", l: "loop", "д": "loop", ",": "back", "б": "back", ".": "fwd", "ю": "fwd" };
    if (v && (e.key === "ArrowLeft" || e.key === "ArrowRight") && e.shiftKey) {
      v.currentTime += e.key === "ArrowLeft" ? -5 : 5; e.preventDefault(); return;
    }
    if (v && e.key === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); return; }
    if (v && (e.key === "[" || e.key === "]" || k === "х" || k === "ъ")) {
      const sel = $("#vSpeed"), opts = [...sel.options].map((o) => o.value);
      const i = Math.max(0, Math.min(opts.length - 1, opts.indexOf(sel.value) + (e.key === "]" || k === "ъ" ? 1 : -1)));
      sel.value = opts[i]; v.playbackRate = +opts[i]; toast(`Скорость ${opts[i]}×`); return;
    }
    if (map[k]) { e.preventDefault(); viewerAct(map[k]); }
    return;
  }
  if (typing) { if (e.key === "Escape") e.target.blur(); return; }
  if (e.key === "Escape") { state.selected.clear(); refreshSelectionMarks(); renderDetails(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "ф")) {
    e.preventDefault();
    state.selected = new Set(state.items.map((i) => i.id));
    refreshSelectionMarks(); renderDetails();
  }
  if (e.key === "Enter" && state.selected.size) openViewer([...state.selected][0]);
  if ((e.ctrlKey && (e.key === "f" || e.key === "а")) || e.key === "/") { e.preventDefault(); $("#search").focus(); }
});

// ======================================================================= старт

(function init() {
  const ts = store("thumb");
  if (ts) { $("#thumbSize").value = ts; document.documentElement.style.setProperty("--thumb", ts + "px"); }
  if (store("contain")) document.body.classList.add("fit-contain");
  const sort = store("sort");
  if (sort) { state.sort = sort; $("#fSort").value = sort; }
  renderDetails();
  Promise.all([loadFolders(), loadTags(), loadSaved()]).then(() => load());
  pollStatus();
})();
