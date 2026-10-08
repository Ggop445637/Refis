// Доски референсов (как PureRef): бесконечный холст, картинки, видео, заметки.
import {
  $, $$, api, esc, toast, menu, modal, confirmDialog, promptDialog, emit, on, isTyping,
  fileUrl, thumbUrl, copyImage, clipboardImages, reduced, plural,
} from "./util.js";
import { openViewer } from "./viewer.js";

const B = {
  id: null, name: "", items: [], view: { x: 0, y: 0, z: 1 },
  sel: new Set(), history: [], future: [], els: new Map(), editing: null,
};
const uid = () => Math.random().toString(36).slice(2, 10);
let saveTimer = null;

// ======================================================================= список досок

export async function renderBoards() {
  const root = $("#boards");
  const list = await api("/boards");
  root.innerHTML = `<header class="rise"><h1>Доски</h1><button class="primary" id="bNew">＋ Новая доска</button></header>
    <div class="bgrid">
      ${list.map((b, i) => `<div class="glass bcard" style="--i:${i}" data-id="${b.id}">
        <div class="prev n${Math.min(b.preview.length, 3)}">${b.preview.length ? b.preview.slice(0, 3).map((s) => `<img src="${esc(previewSrc(s))}" alt="" loading="lazy">`).join("") : '<div class="none">пусто</div>'}</div>
        <div class="info"><b>${esc(b.name)}</b><small>${b.count} ${plural(b.count, "элемент", "элемента", "элементов")} · ${new Date(b.updated_at * 1000).toLocaleDateString("ru-RU")}</small></div>
      </div>`).join("")}
      <div class="glass bcard new" style="--i:${list.length}" id="bNew2"><div><span class="plus">＋</span>Новая доска</div></div>
    </div>`;
  $("#bNew").onclick = $("#bNew2").onclick = () => createBoard();
  $$(".bcard[data-id]", root).forEach((c) => {
    c.onclick = () => openBoard(+c.dataset.id);
    c.oncontextmenu = (e) => {
      e.preventDefault();
      const b = list.find((x) => x.id === +c.dataset.id);
      menu(e, [
        ["Открыть", () => openBoard(b.id)],
        ["Переименовать…", () => promptDialog("Название доски", "", b.name, async (name) => { await api(`/boards/${b.id}`, { method: "PUT", body: { name } }); renderBoards(); })],
        ["Дублировать", async () => {
          const full = await api(`/boards/${b.id}`);
          await api("/boards", { method: "POST", body: { name: b.name + " (копия)", data: full.data } });
          renderBoards();
        }],
        "-",
        ["Удалить…", () => confirmDialog("Удалить доску?", `«${b.name}» исчезнет. Картинки в библиотеке останутся.`, async () => { await api(`/boards/${b.id}`, { method: "DELETE" }); renderBoards(); }, "Удалить")],
      ]);
    };
  });
}
// превью доски: для файлов библиотеки берём лёгкую миниатюру
const previewSrc = (s) => s.replace(/^\/api\/file\/(\d+)$/, "/api/thumb/$1");

export async function createBoard(name) {
  const n = name || `Доска ${new Date().toLocaleDateString("ru-RU")}`;
  const { id } = await api("/boards", { method: "POST", body: { name: n } });
  openBoard(id);
  return id;
}

// ======================================================================= редактор

export async function openBoard(id) {
  const b = await api(`/boards/${id}`);
  Object.assign(B, { id, name: b.name, items: b.data.items || [], view: b.data.view || null, sel: new Set(), history: [], future: [], editing: null });
  emit("navigate", "board");
  buildEditor();
  if (!B.view) fitAll(false);
  else applyView();
  render();
}

export const boardActive = () => $("#boardPage").classList.contains("active") && B.id;

function buildEditor() {
  const page = $("#boardPage");
  page.innerHTML = `
    <div class="btop">
      <button id="bBack" class="ghost">← Доски</button>
      <input class="bname" id="bName" value="${esc(B.name)}">
      <span class="sp"></span>
      <button id="bLib">＋ Из библиотеки</button>
      <button id="bNoteBtn" title="Заметка (N)">✎ Заметка</button>
      <button id="bArrange" title="Аккуратно разложить (A)">▦ Упорядочить</button>
      <button id="bFitBtn" title="Показать всё (F)">⤢ Всё</button>
      <button id="bPin" title="Окно поверх всех — удобно рисовать рядом">📌 Поверх окон</button>
      <button id="bExport" title="Сохранить доску картинкой">⬇ PNG</button>
    </div>
    <div class="bwrap">
      <div class="bcanvas" id="bCanvas" tabindex="0">
        <div class="bworld" id="bWorld"></div>
        <div class="bempty" id="bEmpty"><div><b>Пустая доска</b>Перетащите сюда картинки из библиотеки (＋ Из библиотеки),<br>файлы из проводника или вставьте из буфера — Ctrl+V</div></div>
        <div class="glass bzoom"><button class="ghost mini" id="bZo">−</button><span id="bZoom">100%</span><button class="ghost mini" id="bZi">＋</button></div>
        <div class="glass bhelp">Колесо — зум · тянуть фон — двигать · Shift+тянуть — выделить<br>H зеркало · G ч/б · ] [ слои · Ctrl+D копия · Ctrl+Z отмена</div>
      </div>
      <aside class="bdrawer" id="bDrawer"><div class="inner">
        <input type="search" id="bSearch" placeholder="Поиск: слова, #тег">
        <div class="hint">Перетащите картинку на доску или кликните, чтобы добавить</div>
        <div class="dgrid" id="bDGrid"></div>
      </div></aside>
    </div>`;
  $("#bBack").onclick = () => { flushSave(); emit("navigate", "boards"); };
  $("#bName").onchange = (e) => { B.name = e.target.value.trim() || "Доска"; api(`/boards/${B.id}`, { method: "PUT", body: { name: B.name } }); };
  $("#bName").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
  $("#bLib").onclick = toggleDrawer;
  $("#bNoteBtn").onclick = () => addNote();
  $("#bArrange").onclick = arrange;
  $("#bFitBtn").onclick = () => fitAll(true);
  $("#bPin").onclick = () => emit("toggle-pin");
  $("#bPin").hidden = !window.pywebview?.api;
  $("#bExport").onclick = exportPng;
  $("#bZi").onclick = () => zoomBy(1.25);
  $("#bZo").onclick = () => zoomBy(0.8);
  $("#bSearch").oninput = debounce(loadDrawer, 220);
  bindCanvas();
}

function render() {
  const world = $("#bWorld");
  if (!world) return;
  const seen = new Set();
  const ordered = [...B.items].sort((a, b) => (a.z || 0) - (b.z || 0));
  ordered.forEach((it) => {
    seen.add(it.id);
    let el = B.els.get(it.id);
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      el.className = "bitem";
      el.dataset.id = it.id;
      if (it.type === "note") {
        el.innerHTML = `<div class="bi" data-c="${esc(it.color || "")}"><textarea spellcheck="false" readonly></textarea></div><div class="handle"></div>`;
        const ta = $("textarea", el);
        ta.value = it.text || "";
        ta.oninput = () => { it.text = ta.value; scheduleSave(); };
      } else if (it.mtype === "video") {
        el.innerHTML = `<div class="bi"><video src="${esc(it.src)}" muted loop autoplay playsinline></video></div><div class="handle"></div>`;
      } else {
        el.innerHTML = `<div class="bi"><img src="${esc(it.src)}" alt="" draggable="false"></div><div class="handle"></div>`;
        fixAspectOnLoad(el, it);
      }
      if (it._new) {
        // анимация появления — один раз, только для действительно новых элементов
        el.classList.add("new");
        $(".bi", el).addEventListener("animationend", () => el.classList.remove("new"), { once: true });
        delete it._new;
      }
      B.els.set(it.id, el);
    }
    place(el, it);
    el.classList.toggle("flip", !!it.flip);
    el.classList.toggle("gray", !!it.gray);
    el.classList.toggle("note", it.type === "note");
    el.classList.toggle("sel", B.sel.has(it.id));
    el.classList.toggle("solo", B.sel.size === 1);
    if (it.type === "note") $(".bi", el).dataset.c = it.color || "";
  });
  B.els.forEach((el, id) => { if (!seen.has(id)) { el.remove(); B.els.delete(id); } });
  // порядок слоёв = порядок в DOM; переставляем элементы, только если порядок действительно изменился
  const want = ordered.map((it) => B.els.get(it.id));
  const have = [...world.children];
  if (want.length !== have.length || want.some((el, i) => el !== have[i])) {
    want.forEach((el, i) => { if (world.children[i] !== el) world.insertBefore(el, world.children[i] || null); });
  }
  $("#bEmpty").hidden = B.items.length > 0;
}

/** Если пропорции элемента не совпали с картинкой (размеры были неизвестны) — подгоняем высоту. */
function fixAspectOnLoad(el, it) {
  const img = $("img", el);
  img.addEventListener("load", () => {
    const a = img.naturalWidth / img.naturalHeight;
    if (!a || Math.abs(it.w / it.h - a) < 0.02) return;
    it.h = it.w / a;
    place(el, it);
    scheduleSave();
  }, { once: true });
}

function place(el, it) {
  el.style.left = it.x + "px";
  el.style.top = it.y + "px";
  el.style.width = it.w + "px";
  el.style.height = it.h + "px";
}

// ---------- вид (пан/зум)

function applyView() {
  const { x, y, z } = B.view;
  const world = $("#bWorld");
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  world.style.setProperty("--z", z);
  const c = $("#bCanvas");
  const g = 24 * z;
  c.style.backgroundSize = `${g}px ${g}px`;
  c.style.backgroundPosition = `${x}px ${y}px`;
  $("#bZoom").textContent = Math.round(z * 100) + "%";
}
function zoomAt(cx, cy, nz) {
  nz = Math.min(8, Math.max(0.03, nz));
  const v = B.view;
  v.x = cx - (cx - v.x) * (nz / v.z);
  v.y = cy - (cy - v.y) * (nz / v.z);
  v.z = nz;
  applyView();
  scheduleSave(false);
}
function zoomBy(k) {
  const r = $("#bCanvas").getBoundingClientRect();
  tweenView({ ...zoomTarget(r.width / 2, r.height / 2, B.view.z * k) });
}
function zoomTarget(cx, cy, nz) {
  const v = B.view;
  return { x: cx - (cx - v.x) * (nz / v.z), y: cy - (cy - v.y) * (nz / v.z), z: nz };
}
function tweenView(to, dur = 450) {
  const from = { ...B.view };
  if (reduced()) { Object.assign(B.view, to); applyView(); return; }
  const t0 = performance.now();
  const ease = (k) => 1 - Math.pow(1 - k, 4);
  (function f(t) {
    const k = Math.min(1, (t - t0) / dur), e = ease(k);
    B.view.x = from.x + (to.x - from.x) * e;
    B.view.y = from.y + (to.y - from.y) * e;
    B.view.z = from.z + (to.z - from.z) * e;
    applyView();
    if (k < 1) requestAnimationFrame(f); else scheduleSave(false);
  })(t0);
}
function bounds(items = B.items) {
  if (!items.length) return null;
  const xs = items.map((i) => i.x), ys = items.map((i) => i.y);
  const x2 = items.map((i) => i.x + i.w), y2 = items.map((i) => i.y + i.h);
  const b = { x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...x2), y2: Math.max(...y2) };
  return { ...b, w: b.x2 - b.x, h: b.y2 - b.y };
}
function fitAll(animated = true) {
  const c = $("#bCanvas").getBoundingClientRect();
  const b = bounds();
  const target = b
    ? (() => { const z = Math.min(2, (c.width - 120) / b.w, (c.height - 120) / b.h); return { z, x: (c.width - b.w * z) / 2 - b.x * z, y: (c.height - b.h * z) / 2 - b.y * z }; })()
    : { x: c.width / 2, y: c.height / 2, z: 1 };
  if (!B.view) B.view = { x: 0, y: 0, z: 1 };
  if (animated) tweenView(target); else { Object.assign(B.view, target); applyView(); }
}
const toWorld = (cx, cy) => {
  const r = $("#bCanvas").getBoundingClientRect();
  return { x: (cx - r.left - B.view.x) / B.view.z, y: (cy - r.top - B.view.y) / B.view.z };
};
function viewCenter() {
  const r = $("#bCanvas").getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

// ---------- история и сохранение

function snapshot() {
  B.history.push(JSON.stringify(B.items));
  if (B.history.length > 120) B.history.shift();
  B.future = [];
}
function undo() {
  if (!B.history.length) return toast("Отменять нечего", { life: 1200 });
  B.future.push(JSON.stringify(B.items));
  B.items = JSON.parse(B.history.pop());
  B.sel = new Set([...B.sel].filter((id) => B.items.some((i) => i.id === id)));
  render(); scheduleSave();
}
function redo() {
  if (!B.future.length) return;
  B.history.push(JSON.stringify(B.items));
  B.items = JSON.parse(B.future.pop());
  render(); scheduleSave();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!B.id) return;
  const data = { items: B.items.map(({ _new, ...i }) => i), view: B.view };
  return api(`/boards/${B.id}`, { method: "PUT", body: { data } }).catch(() => {});
}
addEventListener("beforeunload", flushSave);

// ---------- добавление элементов

function topZ() { return B.items.reduce((m, i) => Math.max(m, i.z || 0), 0) + 1; }

function sizeFor(w, h, maxScreen = 380) {
  const max = maxScreen / B.view.z;
  const k = Math.min(1, max / Math.max(w, h)) || 1;
  return { w: Math.max(40, w * k), h: Math.max(40, h * k) };
}

export function addMediaItems(list, at) {
  if (!list.length) return;
  snapshot();
  let { x, y } = at || viewCenter();
  const added = [];
  list.forEach((m, i) => {
    const s = sizeFor(m.width || 800, m.height || 800);
    const it = { id: uid(), type: "media", mid: m.id, mtype: m.type, src: fileUrl(m.id), x: x - s.w / 2 + i * 24 / B.view.z, y: y - s.h / 2 + i * 24 / B.view.z, ...s, z: topZ(), _new: true };
    B.items.push(it);
    added.push(it.id);
  });
  B.sel = new Set(added);
  render(); scheduleSave();
}

async function addFiles(fileList, at) {
  const imgs = fileList.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return toast("На доску можно добавить только картинки");
  const pt = at || viewCenter();
  snapshot();
  const added = [];
  for (const [i, f] of imgs.entries()) {
    const fd = new FormData();
    fd.append("file", f, f.name || "paste.png");
    const { src } = await api("/board-assets", { method: "POST", body: fd });
    const dim = await new Promise((r) => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r([600, 600]); im.src = src; });
    const s = sizeFor(dim[0], dim[1]);
    const it = { id: uid(), type: "asset", src, x: pt.x - s.w / 2 + i * 24 / B.view.z, y: pt.y - s.h / 2 + i * 24 / B.view.z, ...s, z: topZ(), _new: true };
    B.items.push(it);
    added.push(it.id);
  }
  B.sel = new Set(added);
  render(); scheduleSave();
  toast(`Добавлено на доску: ${added.length}`);
}

function addNote(at) {
  snapshot();
  const p = at || viewCenter();
  const w = 260 / B.view.z, h = 150 / B.view.z;
  const it = { id: uid(), type: "note", text: "", color: "", x: p.x - w / 2, y: p.y - h / 2, w, h, z: topZ(), _new: true };
  B.items.push(it);
  B.sel = new Set([it.id]);
  render(); scheduleSave();
  startEdit(it.id);
}

function startEdit(id) {
  const el = B.els.get(id);
  const ta = el && $("textarea", el);
  if (!ta) return;
  B.editing = id;
  el.classList.add("editing");
  ta.readOnly = false;
  ta.focus();
  ta.onblur = () => { ta.readOnly = true; el.classList.remove("editing"); B.editing = null; };
}

// ---------- операции над выделением

const selected = () => B.items.filter((i) => B.sel.has(i.id));
function mutate(fn) { if (!B.sel.size) return; snapshot(); selected().forEach(fn); render(); scheduleSave(); }
function removeSelected() {
  if (!B.sel.size) return;
  snapshot();
  B.items = B.items.filter((i) => !B.sel.has(i.id));
  B.sel.clear();
  render(); scheduleSave();
}
function duplicateSelected() {
  if (!B.sel.size) return;
  snapshot();
  const off = 30 / B.view.z, z = topZ();
  const copies = selected().map((i, k) => ({ ...i, id: uid(), x: i.x + off, y: i.y + off, z: z + k, _new: true }));
  B.items.push(...copies);
  B.sel = new Set(copies.map((c) => c.id));
  render(); scheduleSave();
}
function layer(dir) {
  if (!B.sel.size) return;
  snapshot();
  const zs = B.items.map((i) => i.z || 0);
  const v = dir > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
  selected().forEach((i, k) => (i.z = v + k * dir));
  render(); scheduleSave();
}

/** Раскладывает картинки ровными рядами. */
function arrange() {
  const list = (B.sel.size > 1 ? selected() : B.items).filter((i) => i.type !== "note");
  if (list.length < 2) return toast("Нечего упорядочивать");
  snapshot();
  const b = bounds(list);
  const H = Math.max(...list.map((i) => i.h)) * 0.8 || 300;
  const totalW = list.reduce((s, i) => s + (i.w / i.h) * H, 0);
  const rowW = Math.max(H * 2, Math.sqrt(totalW * H * 1.6));
  const gap = H * 0.06;
  list.sort((a, c) => a.y - c.y || a.x - c.x);
  let row = [], sum = 0, y = b.y;
  const flush = (last) => {
    const h = last ? H : (rowW - gap * (row.length - 1)) / sum;
    let x = b.x;
    row.forEach((i) => { const a = i.w / i.h; i.h = h; i.w = a * h; i.x = x; i.y = y; x += i.w + gap; });
    y += h + gap; row = []; sum = 0;
  };
  list.forEach((i) => { row.push(i); sum += i.w / i.h; if (sum * H >= rowW) flush(false); });
  if (row.length) flush(true);
  animateLayout();
  scheduleSave();
}
function animateLayout() {
  const world = $("#bWorld");
  world.querySelectorAll(".bitem").forEach((el) => (el.style.transition = reduced() ? "" : "left .55s cubic-bezier(.16,1,.3,1), top .55s cubic-bezier(.16,1,.3,1), width .55s cubic-bezier(.16,1,.3,1), height .55s cubic-bezier(.16,1,.3,1)"));
  render();
  setTimeout(() => world.querySelectorAll(".bitem").forEach((el) => (el.style.transition = "")), 600);
}

// ---------- мышь

function bindCanvas() {
  const c = $("#bCanvas");
  let mode = null;

  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(e.clientX - r.left, e.clientY - r.top, B.view.z * Math.exp(-e.deltaY * 0.0016));
    else { B.view.x -= e.deltaX; applyView(); }
  }, { passive: false });

  c.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".bzoom, .bhelp")) return;
    const itemEl = e.target.closest(".bitem");
    if (B.editing && itemEl?.dataset.id === B.editing && e.target.tagName === "TEXTAREA") return;
    if (document.activeElement?.tagName === "TEXTAREA") document.activeElement.blur();
    c.focus({ preventScroll: true });
    const start = { cx: e.clientX, cy: e.clientY, moved: false };
    if (e.button === 1 || (e.button === 0 && !itemEl && !e.shiftKey)) {
      mode = { kind: "pan", ...start, vx: B.view.x, vy: B.view.y };
      c.classList.add("panning");
    } else if (e.button === 0 && e.target.classList.contains("handle")) {
      const it = B.items.find((i) => i.id === itemEl.dataset.id);
      mode = { kind: "resize", ...start, it, w: it.w, h: it.h, snap: JSON.stringify(B.items) };
    } else if (e.button === 0 && itemEl) {
      const id = itemEl.dataset.id;
      if (e.shiftKey || e.ctrlKey) { B.sel.has(id) ? B.sel.delete(id) : B.sel.add(id); }
      else if (!B.sel.has(id)) B.sel = new Set([id]);
      const snap = JSON.stringify(B.items);
      if (e.altKey) { duplicateSelected(); B.history.pop(); }
      render();
      mode = { kind: "move", ...start, snap, orig: selected().map((i) => ({ i, x: i.x, y: i.y })) };
    } else if (e.button === 0 && e.shiftKey) {
      const m = document.createElement("div");
      m.className = "marquee";
      m.style.position = "absolute";
      c.appendChild(m);
      mode = { kind: "marquee", ...start, el: m, base: new Set(B.sel) };
    } else return;
    c.setPointerCapture(e.pointerId);
  });

  c.addEventListener("pointermove", (e) => {
    if (!mode) return;
    const dx = e.clientX - mode.cx, dy = e.clientY - mode.cy;
    if (!mode.moved && Math.hypot(dx, dy) < 3) return;
    mode.moved = true;
    const z = B.view.z;
    if (mode.kind === "pan") {
      B.view.x = mode.vx + dx; B.view.y = mode.vy + dy; applyView();
    } else if (mode.kind === "move") {
      mode.orig.forEach(({ i, x, y }) => { i.x = x + dx / z; i.y = y + dy / z; place(B.els.get(i.id), i); });
    } else if (mode.kind === "resize") {
      const it = mode.it;
      let w = Math.max(30, mode.w + dx / z), h = Math.max(30, mode.h + dy / z);
      if (it.type !== "note" && !e.shiftKey) { const a = mode.w / mode.h; if (w / a > h) h = w / a; else w = h * a; }
      it.w = w; it.h = h; place(B.els.get(it.id), it);
    } else if (mode.kind === "marquee") {
      const r = c.getBoundingClientRect();
      const x = Math.min(e.clientX, mode.cx) - r.left, y = Math.min(e.clientY, mode.cy) - r.top;
      const w = Math.abs(dx), h = Math.abs(dy);
      Object.assign(mode.el.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
      const a = toWorld(x + r.left, y + r.top), b2 = toWorld(x + w + r.left, y + h + r.top);
      B.sel = new Set(mode.base);
      B.items.forEach((i) => { if (i.x < b2.x && i.x + i.w > a.x && i.y < b2.y && i.y + i.h > a.y) B.sel.add(i.id); });
      B.els.forEach((el, id) => el.classList.toggle("sel", B.sel.has(id)));
    }
  });

  c.addEventListener("pointerup", (e) => {
    if (!mode) return;
    c.classList.remove("panning");
    if (mode.kind === "pan" && !mode.moved && e.button === 0) { B.sel.clear(); render(); }
    if ((mode.kind === "move" || mode.kind === "resize") && mode.moved) {
      B.history.push(mode.snap); B.future = [];
      scheduleSave();
    }
    if (mode.kind === "pan" && mode.moved) scheduleSave();
    if (mode.kind === "marquee") { mode.el.remove(); render(); }
    mode = null;
  });

  c.addEventListener("dblclick", (e) => {
    const itemEl = e.target.closest(".bitem");
    if (!itemEl) return addNote(toWorld(e.clientX, e.clientY));
    const it = B.items.find((i) => i.id === itemEl.dataset.id);
    if (it.type === "note") startEdit(it.id);
    else if (it.type === "media") openViewer({ items: [{ id: it.mid, type: it.mtype, name: "", tags: [], width: it.w, height: it.h }] }, it.mid, itemEl);
  });

  c.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const itemEl = e.target.closest(".bitem");
    const at = toWorld(e.clientX, e.clientY);
    if (!itemEl) {
      return menu(e, [
        ["Заметка здесь", () => addNote(at), "N"],
        ["Показать всё", () => fitAll(), "F"],
        ["Упорядочить", arrange, "A"],
        ["Масштаб 100%", () => { const r = c.getBoundingClientRect(); tweenView(zoomTarget(r.width / 2, r.height / 2, 1)); }, "0"],
        "-",
        ["Выделить всё", () => { B.sel = new Set(B.items.map((i) => i.id)); render(); }, "Ctrl A"],
      ]);
    }
    const id = itemEl.dataset.id;
    if (!B.sel.has(id)) { B.sel = new Set([id]); render(); }
    const it = B.items.find((i) => i.id === id);
    const isImg = it.type !== "note" && it.mtype !== "video";
    menu(e, [
      it.type === "note" && ["Редактировать", () => startEdit(id)],
      it.type === "note" && ["Цвет: жёлтый", () => mutate((i) => (i.color = ""))],
      it.type === "note" && ["Цвет: розовый", () => mutate((i) => (i.color = "pink"))],
      it.type === "note" && ["Цвет: голубой", () => mutate((i) => (i.color = "blue"))],
      it.type === "note" && ["Цвет: зелёный", () => mutate((i) => (i.color = "green"))],
      it.type === "note" && ["Цвет: тёмный", () => mutate((i) => (i.color = "dark"))],
      it.type !== "note" && ["Отразить", () => mutate((i) => (i.flip = !i.flip)), "H"],
      it.type !== "note" && ["Чёрно-белое", () => mutate((i) => (i.gray = !i.gray)), "G"],
      isImg && ["Копировать картинку", () => copyImage(it.src), "Ctrl C"],
      it.type === "media" && ["Открыть в просмотре", () => openViewer({ items: [{ id: it.mid, type: it.mtype, name: "", tags: [] }] }, it.mid, itemEl)],
      "-",
      ["На передний план", () => layer(1), "]"],
      ["На задний план", () => layer(-1), "["],
      ["Дублировать", duplicateSelected, "Ctrl D"],
      ["Сбросить размер", () => mutate((i) => {
        const el = $("img, video", B.els.get(i.id));
        const nw = el?.naturalWidth || el?.videoWidth, nh = el?.naturalHeight || el?.videoHeight;
        if (nw) { i.w = nw; i.h = nh; }
      })],
      "-",
      ["Удалить", removeSelected, "Del"],
    ]);
  });

  // перетаскивание из ящика библиотеки и из проводника
  c.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  c.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const at = toWorld(e.clientX, e.clientY);
    const raw = e.dataTransfer.getData("application/x-refis-media");
    if (raw) return addMediaItems([JSON.parse(raw)], at);
    const fl = [...e.dataTransfer.files];
    if (fl.length) return addFiles(fl, at);
    const url = e.dataTransfer.getData("text/uri-list");
    if (url) toast("Картинку из браузера лучше скопировать (ПКМ → Копировать) и вставить Ctrl+V");
  });
}

// ---------- ящик библиотеки

function toggleDrawer() {
  const d = $("#bDrawer");
  d.classList.toggle("open");
  $("#bLib").classList.toggle("on", d.classList.contains("open"));
  if (d.classList.contains("open")) { loadDrawer(); setTimeout(() => $("#bSearch").focus(), 200); }
}
async function loadDrawer() {
  const q = $("#bSearch").value.trim();
  const p = new URLSearchParams({ limit: 120, sort: q ? "new" : "new" });
  if (q) p.set("q", q);
  const { items } = await api("/media?" + p);
  const g = $("#bDGrid");
  g.innerHTML = items.map((it, i) => `<img src="${thumbUrl(it)}" draggable="true" data-i="${i}" style="animation-delay:${Math.min(i, 20) * 20}ms" title="${esc(it.name)}">`).join("");
  $$("img", g).forEach((img) => {
    const it = items[+img.dataset.i];
    const payload = JSON.stringify({ id: it.id, type: it.type, width: it.width, height: it.height });
    img.ondragstart = (e) => { e.dataTransfer.setData("application/x-refis-media", payload); e.dataTransfer.effectAllowed = "copy"; };
    img.onclick = () => addMediaItems([JSON.parse(payload)]);
  });
}

// ---------- экспорт

async function exportPng() {
  const b = bounds();
  if (!b) return toast("Доска пуста");
  const pad = 40;
  const scale = Math.min(2, 8000 / (b.w + pad * 2), 8000 / (b.h + pad * 2));
  const c = document.createElement("canvas");
  c.width = Math.round((b.w + pad * 2) * scale);
  c.height = Math.round((b.h + pad * 2) * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#16161c";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - b.x, pad - b.y);
  toast("Собираю картинку…", { life: 1500 });
  for (const it of [...B.items].sort((a, b2) => (a.z || 0) - (b2.z || 0))) {
    ctx.save();
    if (it.type === "note") {
      const colors = { "": "#fff4c2", pink: "#ffd1dc", blue: "#cfe4ff", green: "#d4f5dc", dark: "#23232c" };
      ctx.fillStyle = colors[it.color || ""];
      ctx.beginPath(); ctx.roundRect(it.x, it.y, it.w, it.h, 6); ctx.fill();
      ctx.fillStyle = it.color === "dark" ? "#eee" : "#2a2414";
      ctx.font = `18px "Segoe UI", sans-serif`;
      wrapText(ctx, it.text || "", it.x + 14, it.y + 30, it.w - 28, 24, it.y + it.h - 8);
    } else {
      const el = $("img, video", B.els.get(it.id));
      if (el) {
        if (it.gray) ctx.filter = "grayscale(1)";
        if (it.flip) { ctx.translate(it.x * 2 + it.w, 0); ctx.scale(-1, 1); }
        try { ctx.drawImage(el, it.x, it.y, it.w, it.h); } catch {}
      }
    }
    ctx.restore();
  }
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const fd = new FormData();
  fd.append("file", blob, `${B.name}.png`);
  const res = await api(`/boards/${B.id}/export`, { method: "POST", body: fd });
  toast(`Сохранено: ${res.path}`, { action: "Показать", life: 6000, onAction: () => api(`/boards/${B.id}/reveal-export?path=${encodeURIComponent(res.path)}`, { method: "POST" }) });
}
function wrapText(ctx, text, x, y, maxW, lh, maxY) {
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(" ")) {
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = w; if (y > maxY) return; }
      else line = t;
    }
    ctx.fillText(line, x, y); y += lh;
    if (y > maxY) return;
  }
}

// ---------- клавиатура и вставка

export function boardKey(e) {
  if (!boardActive() || isTyping(e)) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (k === "z" || k === "я")) { e.shiftKey ? redo() : undo(); return true; }
  if (ctrl && (k === "y" || k === "н")) { redo(); return true; }
  if (ctrl && (k === "d" || k === "в")) { duplicateSelected(); return true; }
  if (ctrl && (k === "a" || k === "ф")) { B.sel = new Set(B.items.map((i) => i.id)); render(); return true; }
  if (ctrl && (k === "c" || k === "с")) {
    const s = selected();
    if (s.length === 1 && s[0].type !== "note" && s[0].mtype !== "video") { copyImage(s[0].src); return true; }
    return false;
  }
  if (ctrl) return false;
  if (k === "Delete" || k === "Backspace") { removeSelected(); return true; }
  if (k === "Escape") { B.sel.clear(); render(); return true; }
  if (k === "h" || k === "р") { mutate((i) => i.type !== "note" && (i.flip = !i.flip)); return true; }
  if (k === "g" || k === "п") { mutate((i) => i.type !== "note" && (i.gray = !i.gray)); return true; }
  if (k === "]" || k === "ъ") { layer(1); return true; }
  if (k === "[" || k === "х") { layer(-1); return true; }
  if (k === "f" || k === "а") { fitAll(); return true; }
  if (k === "a" || k === "ф") { arrange(); return true; }
  if (k === "n" || k === "т") { addNote(); return true; }
  if (k === "0") { const r = $("#bCanvas").getBoundingClientRect(); tweenView(zoomTarget(r.width / 2, r.height / 2, 1)); return true; }
  if (k.startsWith("Arrow") && B.sel.size) {
    const d = (e.shiftKey ? 10 : 1) / B.view.z;
    const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[k];
    mutate((i) => { i.x += dx; i.y += dy; });
    return true;
  }
  return false;
}

export function boardPaste(e) {
  if (!boardActive()) return false;
  const imgs = clipboardImages(e);
  if (imgs.length) { addFiles(imgs); return true; }
  return false;
}
export function boardDrop(e) {
  // файлы из проводника на любую часть страницы доски
  if (!boardActive()) return false;
  const fl = [...e.dataTransfer.files];
  if (fl.length) addFiles(fl, toWorld(e.clientX, e.clientY));
  return true;
}
export const leaveBoard = () => { flushSave(); };

// ======================================================================= «На доску…» из библиотеки

export async function addToBoardDialog(ids) {
  const list = await api("/boards");
  modal(`<h2>Добавить на доску</h2>
    <p>${ids.length} ${plural(ids.length, "файл", "файла", "файлов")}</p>
    <div class="field"><label>Доска</label>
      <div class="opts" id="abList">${list.map((b) => `<button data-id="${b.id}">${esc(b.name)}</button>`).join("") || '<span class="hint">досок пока нет</span>'}</div></div>
    <div class="field"><label>или новая</label><input type="text" id="abNew" placeholder="Название новой доски"></div>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="abOk">Добавить</button></div>`,
    (box, close) => {
      let chosen = list[0]?.id || null;
      const mark = () => $$("#abList button", box).forEach((b) => b.classList.toggle("on", +b.dataset.id === chosen && !$("#abNew", box).value.trim()));
      mark();
      $$("#abList button", box).forEach((b) => (b.onclick = () => { chosen = +b.dataset.id; $("#abNew", box).value = ""; mark(); }));
      $("#abNew", box).oninput = mark;
      $("#abOk", box).onclick = async () => {
        const newName = $("#abNew", box).value.trim();
        let bid = chosen;
        if (newName || !bid) bid = (await api("/boards", { method: "POST", body: { name: newName || "Новая доска" } })).id;
        const board = await api(`/boards/${bid}`);
        const items = board.data.items || [];
        const metas = (await Promise.all(ids.slice(0, 200).map((id) => api(`/media/${id}`).catch(() => null)))).filter(Boolean);
        const b = bounds(items);
        let x = b ? b.x2 + 60 : 0;
        const y = b ? b.y : 0;
        const z = items.reduce((m, i) => Math.max(m, i.z || 0), 0) + 1;
        metas.forEach((m, k) => {
          const h = 400, w = ((m.width || 800) / (m.height || 800)) * h;
          items.push({ id: uid(), type: "media", mid: m.id, mtype: m.type, src: fileUrl(m.id), x, y, w, h, z: z + k });
          x += w + 30;
        });
        await api(`/boards/${bid}`, { method: "PUT", body: { data: { ...board.data, items } } });
        close();
        if (B.id === bid && boardActive()) { B.items = items; render(); }
        toast(`Добавлено на доску «${newName || list.find((l) => l.id === bid)?.name || "Новая доска"}»`, { action: "Открыть", life: 5000, onAction: () => openBoard(bid) });
      };
    });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

on("board-refresh", () => { if (boardActive()) render(); });
