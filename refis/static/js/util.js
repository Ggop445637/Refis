// Общие помощники: DOM, API, уведомления, диалоги, меню, буфер обмена.
import { tr, plural } from "./i18n.js";

// Разделы библиотеки. Встроенные подписываются по языку, свои — как назвал пользователь (см. applySections).
const BUILTIN = {
  ref: [tr("Референс"), tr("Референсы")], own: [tr("Моя работа"), tr("Мои работы")],
  tutorial: [tr("Туториал"), tr("Туториалы")], other: [tr("Прочее"), tr("Прочее")],
};
export const KINDS = Object.fromEntries(Object.entries(BUILTIN).map(([k, v]) => [k, v[0]]));
export const KIND_PLURAL = Object.fromEntries(Object.entries(BUILTIN).map(([k, v]) => [k, v[1]]));
export const SECTIONS = [];

export function applySections(list) {
  SECTIONS.splice(0, SECTIONS.length, ...list);
  [KINDS, KIND_PLURAL].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  for (const s of list) {
    KINDS[s.key] = s.name || BUILTIN[s.key]?.[0] || s.key;
    KIND_PLURAL[s.key] = s.name || BUILTIN[s.key]?.[1] || s.key;
  }
  let st = document.getElementById("sectionColors");
  if (!st) { st = document.createElement("style"); st.id = "sectionColors"; document.head.appendChild(st); }
  const safe = list.filter((s) => /^[a-z0-9]+$/i.test(s.key) && /^#[0-9a-f]{6}$/i.test(s.color));
  st.textContent = `:root{${safe.map((s) => `--k-${s.key}:${s.color};`).join("")}}` + safe.map((s) => `.k-${s.key}{background:${s.color}}`).join("");
}

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("reduce-motion");

/** Шина событий между модулями: tags-changed, library-changed, folders-changed … */
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem("refis." + key));
    localStorage.setItem("refis." + key, JSON.stringify(val));
  } catch { return null; }
}

let tokenPromise = null;
/** Токен сессии: без него сервер не примет изменяющие запросы (защита от чужих сайтов). */
function sessionToken(refresh = false) {
  if (!tokenPromise || refresh) tokenPromise = fetch("/api/session").then((r) => r.json()).then((d) => d.token);
  return tokenPromise;
}

export async function api(path, opts = {}, retry = true) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.body && !(o.body instanceof FormData)) {
    o.body = JSON.stringify(o.body);
    o.headers["Content-Type"] = "application/json";
  }
  if (o.method && o.method !== "GET") o.headers["X-Refis-Token"] = await sessionToken();
  const r = await fetch("/api" + path, o);
  if (r.status === 403 && retry && o.method && o.method !== "GET") {
    await sessionToken(true); // сервер перезапускался — берём новый токен
    return api(path, opts, false);
  }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    toast(typeof msg === "string" ? msg : tr("Ошибка запроса"), { error: true });
    throw new Error(msg);
  }
  return r.json();
}

export const thumbUrl = (it) => `/api/thumb/${it.id}?v=${it.thumb_state ?? 1}`;
export const fileUrl = (id) => `/api/file/${id}`;

// ------------------------------------------------------------ форматирование

export function fmtDur(s) {
  if (s == null || !isFinite(s)) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}
export function fmtSize(b) {
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(1) + tr(" ГБ");
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + tr(" МБ");
  return Math.max(1, Math.round(b / 1024)) + tr(" КБ");
}
export { plural };
export const files = (n) => `${n} ${plural(n, "файл", "файла", "файлов")}`;

// ------------------------------------------------------------ уведомления

export function toast(text, { action, onAction, life = 2800, swatch, error } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  el.style.setProperty("--life", life + "ms");
  el.innerHTML = `${swatch ? `<i class="sw" style="background:${esc(swatch)}"></i>` : ""}${error ? "⚠ " : ""}<span>${esc(text)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action;
    b.onclick = () => { onAction?.(); close(); };
    el.appendChild(b);
  }
  if (error) el.setAttribute("role", "alert"); // ошибки диктор читает сразу, остальное — вежливо (#toasts aria-live)
  const host = $("#toasts");
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  // с кнопкой — даём время дотянуться до неё и с клавиатуры (WCAG 2.2.1)
  let t = setTimeout(close, action ? Math.max(life, 6000) : life);
  const pause = () => clearTimeout(t);
  const resume = () => { clearTimeout(t); t = setTimeout(close, 1200); };
  el.onmouseenter = pause;
  el.onmouseleave = resume;
  el.addEventListener("focusin", pause);
  el.addEventListener("focusout", resume);
  function close() {
    el.classList.add("out");
    setTimeout(() => el.remove(), 240);
  }
}

// ------------------------------------------------------------ модальные окна

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement);

/** Tab и Shift+Tab ходят по кругу внутри root — фокус не убегает за окно (как в диалогах Windows). */
export function trapFocus(root, e) {
  if (e.key !== "Tab") return false;
  const list = focusables(root);
  if (!list.length) { e.preventDefault(); return true; }
  const i = list.indexOf(document.activeElement);
  if (e.shiftKey && (i <= 0)) { e.preventDefault(); list[list.length - 1].focus(); return true; }
  if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); return true; }
  return false;
}

let modalSeq = 0;
export function modal(html, onReady) {
  const m = $("#modal");
  const box = $(".mbox", m);
  // вернём фокус туда, откуда открыли; окно, открытое сразу после другого, помнит исходную кнопку
  const opener = m.hidden || m.classList.contains("closing") ? document.activeElement : m._opener;
  m.classList.remove("closing");
  box.innerHTML = html;
  modalSeq++;
  const h = $("h2", box);
  if (h) { h.id = `mTitle${modalSeq}`; box.setAttribute("aria-labelledby", h.id); } else box.removeAttribute("aria-labelledby");
  const p = $(":scope > p", box);
  if (p) { p.id = `mDesc${modalSeq}`; box.setAttribute("aria-describedby", p.id); } else box.removeAttribute("aria-describedby");
  m.hidden = false;
  m._opener = opener;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    m.classList.add("closing");
    const back = m._opener, seq = modalSeq;
    const restore = () => {
      // если за это время не открыли новое окно, а фокус остался в окне или «повис» — возвращаем на место
      const a = document.activeElement;
      if (seq === modalSeq && back?.isConnected && back !== document.body && (!a || a === document.body || $(".mbox", m).contains(a))) {
        back.focus({ preventScroll: true });
      }
    };
    setTimeout(() => { if (m.classList.contains("closing")) { m.hidden = true; m.classList.remove("closing"); } restore(); }, 170);
    m._opener = null;
    setTimeout(restore, 0); // после текущего события: иначе Enter, закрывший окно, «нажмёт» кнопку, которая его открыла
  };
  m._close = close;
  $$("[data-close]", m).forEach((b) => (b.onclick = close));
  onReady?.(box, close);
  setTimeout(() => {
    if (box.contains(document.activeElement)) return; // окно само выбрало, куда поставить фокус
    ($("input[type=text], input[type=number], textarea", box) || $(".actions .primary", box) || focusables(box)[0])?.focus();
  }, 30);
  return close;
}
$("#modal").addEventListener("keydown", (e) => trapFocus($("#modal .mbox"), e));
export const closeModal = () => $("#modal")._close?.();
export const modalOpen = () => !$("#modal").hidden && !$("#modal").classList.contains("closing");

/** Подтверждение. danger — необратимое или опасное действие: красная кнопка, а фокус по умолчанию на «Отмене»,
 *  чтобы случайный Enter ничего не удалил. */
export function confirmDialog(title, text, onOk, okLabel = tr("Да"), { danger = false } = {}) {
  modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p>
    <div class="actions"><button data-close id="mCancel">${tr("Отмена")}</button><button class="${danger ? "danger strong" : "primary"}" id="mOk">${esc(okLabel)}</button></div>`,
    (box, close) => {
      $("#mOk", box).onclick = async () => { close(); await onOk(); };
      $(danger ? "#mCancel" : "#mOk", box).focus();
    });
}

export function promptDialog(title, text, value, onOk) {
  modal(`<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ""}<input type="text" id="mVal" value="${esc(value)}" aria-label="${esc(title)}">
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="mOk">${tr("Готово")}</button></div>`,
    (box, close) => {
      const ok = async () => { const v = $("#mVal", box).value.trim(); if (!v) return; close(); await onOk(v); };
      $("#mOk", box).onclick = ok;
      $("#mVal", box).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } };
      $("#mVal", box).focus();
      $("#mVal", box).select();
    });
}

// ------------------------------------------------------------ контекстное меню

let menuOpener = null;
export function menu(e, items) {
  const m = $("#ctxmenu");
  m.innerHTML = "";
  items.filter(Boolean).forEach((it) => {
    if (it === "-") { const hr = document.createElement("hr"); hr.setAttribute("role", "separator"); m.appendChild(hr); return; }
    const [label, fn, key] = it;
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.innerHTML = `<span>${esc(label)}</span>${key ? `<kbd aria-hidden="true">${esc(key)}</kbd>` : ""}`;
    b.onclick = () => { closeMenu(false); fn(); };
    m.appendChild(b);
  });
  menuOpener = document.activeElement;
  m.hidden = false;
  m.style.animation = "none";
  void m.offsetWidth;
  m.style.animation = "";
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8)) + "px";
  // открыли с клавиатуры (Shift+F10, клавиша меню) — сразу ставим фокус на первый пункт
  if (!e.isTrusted || e.type === "keydown" || e.detail === 0) $("button", m)?.focus();
}
function closeMenu(restore = true) {
  const m = $("#ctxmenu");
  if (m.hidden) return;
  m.hidden = true;
  const back = menuOpener;
  if (restore && back?.isConnected) setTimeout(() => back.focus({ preventScroll: true }), 0);
}
export const menuOpen = () => !$("#ctxmenu").hidden;
// меню с клавиатуры: стрелки, Home/End, Esc — как в меню Windows
addEventListener("keydown", (e) => {
  if (!menuOpen()) return;
  const items = [...$$("#ctxmenu button")];
  const i = items.indexOf(document.activeElement);
  const go = (j) => { e.preventDefault(); items[(j + items.length) % items.length]?.focus(); };
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(); }
  else if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
  else if (e.key === "Tab") { e.preventDefault(); closeMenu(); }
  else return;
  e.stopImmediatePropagation();
}, true);
addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctxmenu")) closeMenu(false); }, true);
addEventListener("blur", () => closeMenu(false));

/** Shift+F10 или клавиша меню: открыть контекстное меню элемента, на котором фокус. */
export function openContextMenuFor(el) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(24, r.width / 2), clientY: r.top + Math.min(r.height, 32), detail: 0 }));
}

// ------------------------------------------------------------ движение

/** Плавный счётчик чисел. */
export function countUp(el, to, dur = 900) {
  if (reduced()) { el.textContent = to; return; }
  const from = 0, t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 4);
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Переход между состояниями через View Transitions API (если есть). */
export function transition(fn) {
  if (document.startViewTransition && !reduced()) {
    const t = document.startViewTransition(fn);
    t.ready.catch(() => {}); // новый переход прервал этот — это нормально, не ошибка
    return t;
  }
  fn();
}

/** Конфетти для празднования окончания тренировки. */
export function confetti() {
  if (reduced()) return;
  const c = document.createElement("canvas");
  c.className = "confetti";
  c.width = innerWidth * devicePixelRatio;
  c.height = innerHeight * devicePixelRatio;
  document.body.appendChild(c);
  const ctx = c.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const colors = ["#ffc371", "#ff6b6b", "#7c5cff", "#5ee6a0", "#6aa8ff"];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight * .55,
    vx: (Math.random() - .5) * 16, vy: -Math.random() * 18 - 6,
    r: Math.random() * Math.PI, vr: (Math.random() - .5) * .4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const age = (t - t0) / 1000;
    parts.forEach((p) => {
      p.vy += .45; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - age / 2.6);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    });
    if (age < 2.6) requestAnimationFrame(frame); else c.remove();
  })(t0);
}

// ------------------------------------------------------------ буфер обмена

/** Копирует картинку как PNG — потом её можно вставить в Photoshop, Krita, CSP. */
export async function copyImage(src) {
  try {
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast(tr("Картинка скопирована — вставьте её в редактор (Ctrl+V)"));
  } catch (e) {
    toast(tr("Не удалось скопировать картинку"), { error: true });
  }
}

export async function copyText(text, swatch) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${tr("Скопировано")}: ${text}`, { swatch });
  } catch {
    toast(text, { swatch });
  }
}

/** Достаёт картинки из события вставки. */
export function clipboardImages(e) {
  return [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => {
      const f = i.getAsFile();
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      return new File([f], f.name && f.name !== "image.png" ? f.name : `${tr("вставка")}-${stamp}.${ext}`, { type: f.type });
    });
}

export const isTyping = (e) => e.target.matches?.("input, textarea, select, [contenteditable]");
export const desktop = () => !!window.pywebview?.api;
