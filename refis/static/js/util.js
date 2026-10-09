// Общие помощники: DOM, API, уведомления, диалоги, меню, буфер обмена.

export const KINDS = { ref: "Референс", own: "Моя работа", tutorial: "Туториал", other: "Прочее" };
export const KIND_PLURAL = { ref: "Референсы", own: "Мои работы", tutorial: "Туториалы", other: "Прочее" };

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
    toast(typeof msg === "string" ? msg : "Ошибка запроса", { error: true });
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
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(1) + " ГБ";
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + " МБ";
  return Math.max(1, Math.round(b / 1024)) + " КБ";
}
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
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
  const host = $("#toasts");
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  let t = setTimeout(close, life);
  el.onmouseenter = () => clearTimeout(t);
  el.onmouseleave = () => { t = setTimeout(close, 1200); };
  function close() {
    el.classList.add("out");
    setTimeout(() => el.remove(), 240);
  }
}

// ------------------------------------------------------------ модальные окна

export function modal(html, onReady) {
  const m = $("#modal");
  m.classList.remove("closing");
  $(".mbox", m).innerHTML = html;
  m.hidden = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    m.classList.add("closing");
    setTimeout(() => { if (m.classList.contains("closing")) { m.hidden = true; m.classList.remove("closing"); } }, 180);
  };
  m._close = close;
  $$("[data-close]", m).forEach((b) => (b.onclick = close));
  onReady?.($(".mbox", m), close);
  setTimeout(() => $("input[type=text], input[type=number], textarea", m)?.focus(), 30);
  return close;
}
export const closeModal = () => $("#modal")._close?.();
export const modalOpen = () => !$("#modal").hidden && !$("#modal").classList.contains("closing");

export function confirmDialog(title, text, onOk, okLabel = "Да") {
  modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p>
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="mOk">${esc(okLabel)}</button></div>`,
    (box, close) => { $("#mOk", box).onclick = async () => { close(); await onOk(); }; setTimeout(() => $("#mOk", box).focus(), 40); });
}

export function promptDialog(title, text, value, onOk) {
  modal(`<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ""}<input type="text" id="mVal" value="${esc(value)}">
    <div class="actions"><button data-close>Отмена</button><button class="primary" id="mOk">Готово</button></div>`,
    (box, close) => {
      const ok = async () => { const v = $("#mVal", box).value.trim(); if (!v) return; close(); await onOk(v); };
      $("#mOk", box).onclick = ok;
      $("#mVal", box).onkeydown = (e) => { if (e.key === "Enter") ok(); };
      setTimeout(() => $("#mVal", box).select(), 40);
    });
}

// ------------------------------------------------------------ контекстное меню

export function menu(e, items) {
  const m = $("#ctxmenu");
  m.innerHTML = "";
  items.filter(Boolean).forEach((it) => {
    if (it === "-") { m.appendChild(document.createElement("hr")); return; }
    const [label, fn, key] = it;
    const b = document.createElement("button");
    b.innerHTML = `<span>${esc(label)}</span>${key ? `<kbd>${esc(key)}</kbd>` : ""}`;
    b.onclick = () => { m.hidden = true; fn(); };
    m.appendChild(b);
  });
  m.hidden = false;
  m.style.animation = "none";
  void m.offsetWidth;
  m.style.animation = "";
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + "px";
}
addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctxmenu")) $("#ctxmenu").hidden = true; }, true);
addEventListener("blur", () => { $("#ctxmenu").hidden = true; });

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
  if (document.startViewTransition && !reduced()) return document.startViewTransition(fn);
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
    toast("Картинка скопирована — вставьте её в редактор (Ctrl+V)");
  } catch (e) {
    toast("Не удалось скопировать картинку", { error: true });
  }
}

export async function copyText(text, swatch) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Скопировано: ${text}`, { swatch });
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
      return new File([f], f.name && f.name !== "image.png" ? f.name : `вставка-${stamp}.${ext}`, { type: f.type });
    });
}

export const isTyping = (e) => e.target.matches?.("input, textarea, select, [contenteditable]");
export const desktop = () => !!window.pywebview?.api;
