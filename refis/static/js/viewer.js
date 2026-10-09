// Полноэкранный просмотр: FLIP-анимация из карточки, зум, зеркало, сетка, пипетка, видео.
import { tr } from "./i18n.js";
import { $, $$, api, esc, store, toast, fmtDur, thumbUrl, fileUrl, copyImage, copyText, reduced } from "./util.js";
import { addToBoardDialog } from "./boards.js";

const V = {
  src: null, id: null, open: false,
  mirror: false, gray: false, blur: false, grid: 0, rot: 0, loop: true,
  scale: 1, x: 0, y: 0, natW: 1, natH: 1, box: null, media: null,
};
const root = $("#viewer");
const stage = $("#vStage");

const item = () => V.src.items.find((i) => i.id === V.id);
const ew = () => (V.rot % 180 ? V.natH : V.natW);
const eh = () => (V.rot % 180 ? V.natW : V.natH);

function boxTransform(x, y, s) {
  return `translate(${x}px, ${y}px) scale(${s}) translate(${ew() / 2}px, ${eh() / 2}px) rotate(${V.rot}deg) translate(${-V.natW / 2}px, ${-V.natH / 2}px)`;
}
function apply() {
  if (V.box) V.box.style.transform = boxTransform(V.x, V.y, V.scale);
}
function fitParams() {
  const r = stage.getBoundingClientRect();
  const max = V.media?.tagName === "VIDEO" ? 4 : 2;
  const s = Math.min((r.width - 40) / ew(), (r.height - 40) / eh(), max);
  return { s, x: (r.width - ew() * s) / 2, y: (r.height - eh() * s) / 2 };
}
function fit(animated = true) {
  const f = fitParams();
  animateTo(f.x, f.y, f.s, animated ? 380 : 0);
}
function animateTo(x, y, s, dur = 320) {
  if (!V.box) return;
  const from = boxTransform(V.x, V.y, V.scale);
  V.x = x; V.y = y; V.scale = s;
  const to = boxTransform(x, y, s);
  if (dur && !reduced()) V.box.animate([{ transform: from }, { transform: to }], { duration: dur, easing: "cubic-bezier(.16,1,.3,1)" });
  apply();
}

function gridSvg(n) {
  const lines = [];
  for (let i = 1; i < n; i++) {
    const p = (100 * i) / n;
    lines.push(`<line x1="${p}" y1="0" x2="${p}" y2="100"/><line x1="0" y1="${p}" x2="100" y2="${p}"/>`);
  }
  lines.push(`<line x1="0" y1="0" x2="100" y2="100" opacity=".35"/><line x1="100" y1="0" x2="0" y2="100" opacity=".35"/>`);
  return `<svg class="vgrid${n ? " on" : ""}" viewBox="0 0 100 100" preserveAspectRatio="none">
    <g stroke="#fff" stroke-width="1.5" style="mix-blend-mode:difference">${lines.join("")}</g></svg>`;
}

// ======================================================================= открыть / показать

export function openViewer(source, id, fromEl) {
  V.src = source;
  V.id = id;
  V.mirror = false; // зеркало — временный инструмент, не переносим между открытиями
  root.hidden = false;
  V.open = true;
  requestAnimationFrame(() => root.classList.add("show"));
  show(fromEl, 0);
}

const fullSrc = (it) => it.src || fileUrl(it.id);
const lowSrc = (it) => it.thumb || thumbUrl(it);

function show(fromEl, dir) {
  const it = item();
  if (!it) return close();
  V.rot = 0;
  stage.className = "stage" + (V.gray ? " gray" : "") + (V.blur ? " blur" : "");
  root.classList.toggle("is-video", it.type === "video");
  root.classList.toggle("external", !!it.external);
  const idx = V.src.items.indexOf(it);
  const total = V.src.total?.() ?? V.src.items.length;
  $("#vTitle").innerHTML = `<span>${idx + 1} / ${total}</span><b>${esc(it.name || "")}</b>${it.tags?.length ? `<span>${esc(it.tags.join(" · "))}</span>` : ""}`;
  $('[data-act="fav"]').textContent = it.favorite ? "♥" : "♡";
  syncButtons();
  if (!it.external) api(`/media/${it.id}/viewed`, { method: "POST" }).catch(() => {});

  const known = !!(it.width && it.height);
  V.natW = it.width || 1000;
  V.natH = it.height || 1000;
  const old = V.box;
  const box = document.createElement("div");
  box.className = "vbox" + (V.mirror ? " mirror" : "");
  V.box = box;
  const size = () => { box.style.width = V.natW + "px"; box.style.height = V.natH + "px"; };
  size();

  let media;
  if (it.type === "video") {
    media = document.createElement("video");
    media.src = fullSrc(it);
    media.poster = lowSrc(it);
    media.autoplay = true;
    media.loop = V.loop;
    media.muted = !!store("muted");
    media.playbackRate = +$("#vSpeed").value;
    media.onloadedmetadata = () => {
      if (media.videoWidth && (media.videoWidth !== V.natW || media.videoHeight !== V.natH)) {
        V.natW = media.videoWidth; V.natH = media.videoHeight;
        size(); fit(false);
      }
    };
    media.onerror = () => {
      box.remove();
      stage.insertAdjacentHTML("beforeend", `<div class="empty-state" style="padding-top:20vh">
        <div class="big">🎞️</div><h2>${tr("Этот формат не играет встроенный плеер")}</h2><p>${tr("Откройте видео в системном плеере.")}</p>
        <button class="primary" id="vExt">${tr("Открыть в плеере")}</button></div>`);
      $("#vExt").onclick = () => api(`/media/${it.id}/open`, { method: "POST" });
    };
    box.appendChild(media);
    bindVideoBar(media);
  } else {
    const low = new Image();
    low.className = "lowres";
    low.draggable = false;
    media = new Image();
    media.className = "full";
    media.draggable = false;
    media.onload = () => {
      media.classList.add("loaded");
      setTimeout(() => low.remove(), 400);
      // настоящие размеры (с учётом поворота из EXIF) — подгоняем рамку без «прыжка» пропорций
      if (Math.abs(media.naturalWidth / media.naturalHeight - V.natW / V.natH) > 0.01) {
        V.natW = media.naturalWidth; V.natH = media.naturalHeight;
        size(); fit(false);
      }
    };
    media.onerror = () => { media.remove(); };
    low.src = lowSrc(it);
    media.src = fullSrc(it);
    box.append(low, media);
    if (!it.external) loadPalette(it); else $("#vPalette").innerHTML = "";
    if (!known) {
      // размеры неизвестны — сначала узнаём пропорции по превью, потом показываем
      box.style.visibility = "hidden";
      const reveal = () => {
        if (V.box !== box) return;
        const w = low.naturalWidth || media.naturalWidth, h = low.naturalHeight || media.naturalHeight;
        if (w && h) { V.natW = 1000 * w / Math.max(w, h); V.natH = 1000 * h / Math.max(w, h); size(); }
        box.style.visibility = "";
        enter(box, fromEl, dir);
      };
      low.decode().then(reveal, () => (media.complete ? reveal() : media.addEventListener("load", reveal, { once: true })));
    }
  }
  box.insertAdjacentHTML("beforeend", gridSvg(V.grid));
  V.media = media;
  stage.innerHTML = "";
  stage.appendChild(box);
  if (old) old.remove();
  if (known || it.type === "video") enter(box, fromEl, dir);
}

function enter(box, fromEl, dir) {
  const f = fitParams();
  V.x = f.x; V.y = f.y; V.scale = f.s;
  apply();
  if (reduced()) return;
  if (fromEl) {
    // FLIP: стартуем из прямоугольника карточки
    const r = fromEl.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const s0 = Math.min(r.width / ew(), r.height / eh());
    const x0 = r.left - sr.left + (r.width - ew() * s0) / 2, y0 = r.top - sr.top + (r.height - eh() * s0) / 2;
    box.animate([{ transform: boxTransform(x0, y0, s0), opacity: .4 }, { transform: boxTransform(f.x, f.y, f.s), opacity: 1 }],
      { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" });
  } else if (dir) {
    box.animate([{ transform: `translateX(${dir * 60}px) ` + boxTransform(f.x, f.y, f.s), opacity: 0 }, { transform: boxTransform(f.x, f.y, f.s), opacity: 1 }],
      { duration: 420, easing: "cubic-bezier(.16,1,.3,1)" });
  }
}

function loadPalette(it) {
  const pal = $("#vPalette");
  pal.innerHTML = "";
  api(`/media/${it.id}/palette?n=8`).then((cols) => {
    if (V.id !== it.id) return;
    pal.innerHTML = cols.map((c) => `<i style="background:${c.hex}" data-hex="${c.hex}"></i>`).join("");
    $$("i", pal).forEach((i) => (i.onclick = () => copyText(i.dataset.hex, i.dataset.hex)));
  }).catch(() => {});
}

export function closeViewer() { close(); }
function close() {
  if (!V.open) return;
  V.open = false;
  const it = item();
  const card = it && V.src.cardEl?.(it.id);
  const box = V.box;
  const done = () => {
    root.hidden = true;
    stage.innerHTML = "";
    V.box = null; V.media = null;
  };
  root.classList.remove("show");
  V.media?.tagName === "VIDEO" && V.media.pause();
  if (reduced() || !box) return done();
  const r = card?.getBoundingClientRect();
  const visible = r && r.bottom > 0 && r.top < innerHeight && r.width > 0;
  let anim;
  if (visible) {
    const sr = stage.getBoundingClientRect();
    const s0 = Math.min(r.width / ew(), r.height / eh());
    const x0 = r.left - sr.left + (r.width - ew() * s0) / 2, y0 = r.top - sr.top + (r.height - eh() * s0) / 2;
    anim = box.animate([{ transform: boxTransform(V.x, V.y, V.scale), opacity: 1 }, { transform: boxTransform(x0, y0, s0), opacity: .3 }],
      { duration: 380, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
  } else {
    anim = box.animate([{ opacity: 1, transform: boxTransform(V.x, V.y, V.scale) }, { opacity: 0, transform: boxTransform(V.x, V.y + 30, V.scale * .96) }],
      { duration: 240, easing: "ease-in", fill: "forwards" });
  }
  anim.onfinish = done;
}

function step(d) {
  const items = V.src.items;
  const idx = items.findIndex((i) => i.id === V.id);
  const n = idx + d;
  if (n < 0) return;
  if (n >= items.length) {
    if (V.src.loadMore && items.length < (V.src.total?.() ?? 0)) V.src.loadMore();
    return;
  }
  if (n >= items.length - 3) V.src.loadMore?.();
  V.id = items[n].id;
  V.src.onNavigate?.(V.id);
  show(null, d);
}

function syncButtons() {
  $('[data-act="mirror"]').classList.toggle("on", V.mirror);
  $('[data-act="gray"]').classList.toggle("on", V.gray);
  $('[data-act="blur"]').classList.toggle("on", V.blur);
  $('[data-act="grid"]').classList.toggle("on", !!V.grid);
  $('[data-act="grid"]').textContent = V.grid ? `# ${V.grid}×${V.grid}` : "#";
  $('[data-act="rotate"]').classList.toggle("on", !!V.rot);
  $('[data-act="loop"]').classList.toggle("on", V.loop);
}
$("#pickBtn").hidden = !("EyeDropper" in window);

async function act(a) {
  const v = V.media?.tagName === "VIDEO" ? V.media : null;
  const it = item();
  switch (a) {
    case "close": return close();
    case "prev": return step(-1);
    case "next": return step(1);
    case "mirror": V.mirror = !V.mirror; V.box?.classList.toggle("mirror", V.mirror); break;
    case "gray": V.gray = !V.gray; stage.classList.toggle("gray", V.gray); break;
    case "blur": V.blur = !V.blur; stage.classList.toggle("blur", V.blur); break;
    case "grid": {
      V.grid = { 0: 3, 3: 4, 4: 0 }[V.grid];
      const g = $(".vgrid", V.box);
      if (g) g.outerHTML = gridSvg(V.grid);
      break;
    }
    case "rotate": {
      V.rot = (V.rot + 90) % 360;
      fit(true);
      break;
    }
    case "fit": fit(); break;
    case "loop": V.loop = !V.loop; if (v) v.loop = V.loop; break;
    case "back": if (v) { v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / 30); } break;
    case "fwd": if (v) { v.pause(); v.currentTime += 1 / 30; } break;
    case "copy": if (it.type === "image") copyImage(fullSrc(it)); else toast(tr("Копировать можно только картинки")); break;
    case "pick": {
      if (!("EyeDropper" in window)) return;
      try {
        const { sRGBHex } = await new window.EyeDropper().open();
        copyText(sRGBHex, sRGBHex);
      } catch {}
      break;
    }
    case "board": if (it.external) return toast(tr("Сначала сохраните картинку в библиотеку")); addToBoardDialog([it.id]); break;
    case "fav": {
      if (it.external) return;
      it.favorite = it.favorite ? 0 : 1;
      await api(`/media/${it.id}`, { method: "PATCH", body: { favorite: !!it.favorite } });
      $('[data-act="fav"]').textContent = it.favorite ? "♥" : "♡";
      V.src.onChange?.(it.id);
      toast(it.favorite ? tr("♥ В избранном") : tr("Убрано из избранного"));
      break;
    }
  }
  syncButtons();
}
root.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (b) act(b.dataset.act);
});
$("#vSpeed").onchange = (e) => { if (V.media?.tagName === "VIDEO") V.media.playbackRate = +e.target.value; };

// ---------- зум и перетаскивание

let zoomTimer;
function showZoom() {
  const z = $("#zoomInd");
  z.textContent = Math.round(V.scale * 100) + "%";
  z.classList.add("show");
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => z.classList.remove("show"), 700);
}
stage.addEventListener("wheel", (e) => {
  if (!V.box) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const ns = Math.min(30, Math.max(0.03, V.scale * Math.exp(-e.deltaY * 0.0015)));
  V.x = mx - (mx - V.x) * (ns / V.scale);
  V.y = my - (my - V.y) * (ns / V.scale);
  V.scale = ns;
  apply();
  showZoom();
}, { passive: false });

let drag = null, dragMoved = false;
stage.addEventListener("pointerdown", (e) => {
  if (!V.box || e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, ox: V.x, oy: V.y };
  dragMoved = false;
  stage.setPointerCapture(e.pointerId);
  stage.style.cursor = "grabbing";
});
stage.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) dragMoved = true;
  V.x = drag.ox + e.clientX - drag.x;
  V.y = drag.oy + e.clientY - drag.y;
  apply();
});
stage.addEventListener("pointerup", (e) => {
  stage.style.cursor = "";
  if (drag && !dragMoved) {
    // клик по пустому месту закрывает, по видео — пауза
    const v = V.media?.tagName === "VIDEO" ? V.media : null;
    const inside = V.box && V.box.contains(document.elementFromPoint(e.clientX, e.clientY));
    if (v && inside) v.paused ? v.play() : v.pause();
    else if (!inside) close();
  }
  drag = null;
});
stage.addEventListener("dblclick", (e) => {
  if (!V.box) return;
  const f = fitParams();
  if (Math.abs(V.scale - f.s) > 0.01) return fit();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const ns = Math.max(1, f.s * 2.2);
  animateTo(mx - (mx - V.x) * (ns / V.scale), my - (my - V.y) * (ns / V.scale), ns);
  showZoom();
});
addEventListener("resize", () => { if (V.open && V.box) fit(false); });

// ---------- видео

function bindVideoBar(v) {
  const seek = $("#vSeek"), play = $("#vPlay"), time = $("#vTime"), mute = $("#vMute");
  const upd = () => {
    if (!seek.matches(":active")) seek.value = v.duration ? (1000 * v.currentTime) / v.duration : 0;
    time.textContent = `${fmtT(v.currentTime)} / ${fmtT(v.duration)}`;
    play.textContent = v.paused ? "▶" : "❚❚";
    mute.textContent = v.muted ? "🔇" : "🔊";
  };
  ["timeupdate", "play", "pause", "loadedmetadata", "volumechange", "seeked"].forEach((ev) => v.addEventListener(ev, upd));
  seek.oninput = () => { if (v.duration) v.currentTime = (seek.value / 1000) * v.duration; };
  play.onclick = () => (v.paused ? v.play() : v.pause());
  mute.onclick = () => { v.muted = !v.muted; store("muted", v.muted); };
  upd();
}
function fmtT(s) {
  if (!isFinite(s)) return "0:00.0";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

// ---------- клавиатура

export const viewerOpen = () => V.open;
export function viewerKey(e) {
  if (!V.open) return false;
  const v = V.media?.tagName === "VIDEO" ? V.media : null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "с")) { act("copy"); return true; }
  if (v && (k === "ArrowLeft" || k === "ArrowRight") && e.shiftKey) { v.currentTime += k === "ArrowLeft" ? -5 : 5; return true; }
  if (v && k === " ") { v.paused ? v.play() : v.pause(); return true; }
  if (v && (k === "m" || k === "ь")) { v.muted = !v.muted; store("muted", v.muted); return true; }
  if (v && ["[", "]", "х", "ъ"].includes(k)) {
    const sel = $("#vSpeed"), opts = [...sel.options].map((o) => o.value);
    const i = Math.max(0, Math.min(opts.length - 1, opts.indexOf(sel.value) + (k === "]" || k === "ъ" ? 1 : -1)));
    sel.value = opts[i]; v.playbackRate = +opts[i]; toast(`${tr("Скорость")} ${opts[i]}×`, { life: 1200 });
    return true;
  }
  if (!v && k === " ") { step(1); return true; }
  if (/^[0-5]$/.test(k) && !e.ctrlKey && k !== "0" && !item().external) {
    const it = item();
    it.rating = +k;
    api(`/media/${it.id}`, { method: "PATCH", body: { rating: it.rating } }).then(() => V.src.onChange?.(it.id));
    toast(`${tr("Оценка")} ${"★".repeat(it.rating)}`, { life: 1200 });
    return true;
  }
  const map = {
    Escape: "close", ArrowLeft: "prev", ArrowRight: "next",
    h: "mirror", "р": "mirror", g: "gray", "п": "gray", b: "blur", "и": "blur", s: "grid", "ы": "grid",
    r: "rotate", "к": "rotate", f: "fav", "а": "fav", "0": "fit", l: "loop", "д": "loop",
    ",": "back", "б": "back", ".": "fwd", "ю": "fwd", i: "pick", "ш": "pick",
  };
  if (map[k]) { act(map[k]); return true; }
  return true; // просмотр модальный — остальные клавиши не уходят в сетку
}
