// Страница «Сегодня»: сначала — порядок в библиотеке, затем референс дня и задания из ваших тем.
import { $, $$, api, esc, countUp, thumbUrl, fmtDur, plural, files, emit, on } from "./util.js";
import { openViewer } from "./viewer.js";
import { runSession } from "./practice.js";
import { state as lib, toggleTag, applyQuery } from "./library.js";
import { openTriage, updateBadge } from "./organize.js";
import { settings } from "./settings.js";

let todayN = 0;
let challengeN = 0;
let stats = null;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
}

export async function renderToday() {
  const root = $("#today");
  const [st, health, pins] = await Promise.all([api("/stats"), api("/organize/health"), api("/pinterest/pins?limit=14").catch(() => ({ items: [] }))]);
  stats = st;
  updateBadge(health);
  const p = stats.practice;
  const date = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  const hello = `<div class="hello rise"><h1>${greeting()}, <span>${esc(settings.name || "художник")}</span></h1>
    <p>${date[0].toUpperCase() + date.slice(1)}${p.streak ? ` · серия ${p.streak} ${plural(p.streak, "день", "дня", "дней")} подряд 🔥` : ""}</p></div>`;

  if (!stats.total) {
    root.innerHTML = hello + `
      <div class="glass rise org-banner big" style="--d:1">
        <div class="big-emoji">🗂️</div>
        <div><h2>Начнём с порядка</h2>
          <p>Refis найдёт на компьютере папки с картинками и видео, поможет разложить их по типам и тегам.
            Потом на основе вашей библиотеки будут появляться референс дня, задания и подборки.</p>
          <div class="row"><button class="primary" id="tStart">🔍 Найти мои папки</button></div></div>
      </div>`;
    $("#tStart").onclick = () => emit("navigate", "organize");
    return;
  }

  const orgBanner = health.ready ? "" : `
    <div class="glass rise org-banner" style="--d:1">
      <div class="mini-ring" style="--p:${health.score}"><span>${health.score}%</span></div>
      <div class="txt"><h2>Сначала наведём порядок</h2>
        <p>Размечено ${files(health.total - health.untagged)} из ${health.total}. Когда у файлов появятся теги,
          референс дня и задания будут подбираться по вашим темам — и по тем, которые вы давно не практиковали.</p></div>
      <div class="row"><button class="primary" data-org="page">Открыть «Порядок»</button>${health.untagged ? `<button data-org="triage">🏷 Быстрая разметка</button>` : ""}</div>
    </div>`;

  root.innerHTML = hello + orgBanner + `
    <div class="t-grid">
      <div class="glass hero rise" style="--d:2" id="hero"><div class="bg"></div><div class="content"></div></div>
      <div class="glass challenge rise" style="--d:3" id="challenge"></div>
    </div>
    <div class="tiles">
      <div class="glass tile link rise" style="--d:4" data-go="all"><span class="ico">🖼️</span><div class="num" data-n="${stats.total}">0</div><div class="lbl">файлов в библиотеке</div></div>
      <div class="glass tile link rise" style="--d:5" data-org="page"><span class="ico">🏷️</span><div class="num" data-n="${health.score}">0</div><div class="lbl">% порядка — ${health.untagged ? `без тегов ${health.untagged} →` : "всё размечено ✓"}</div></div>
      <div class="glass tile flame rise" style="--d:6"><span class="ico">🔥</span><div class="num" data-n="${p.streak}">0</div><div class="lbl">${plural(p.streak, "день", "дня", "дней")} практики подряд</div></div>
      <div class="glass tile rise" style="--d:7"><span class="ico">⏱️</span><div class="num" data-n="${p.week_minutes}">0</div><div class="lbl">минут рисования за неделю</div></div>
    </div>
    <div class="glass heat rise" style="--d:8"><h3>Практика <small>последние 16 недель · ${p.total_sessions} ${plural(p.total_sessions, "сессия", "сессии", "сессий")}</small></h3><div class="heatgrid" id="heat"></div></div>
    ${pins.items.length ? `<div class="glass strip rise" style="--d:9"><h3>Новое с Pinterest <small><a href="#" id="toPins">все пины →</a></small></h3><div class="row-scroll" id="pinsStrip"></div></div>` : ""}
    ${stats.recent.length ? `<div class="glass strip rise" style="--d:10"><h3>Недавно добавленные <small>${files(stats.total)}</small></h3><div class="row-scroll" id="recent"></div></div>` : ""}
    ${stats.forgotten.length ? `<div class="glass strip rise" style="--d:11"><h3>Давно не открывали <small>вспомнить старое</small></h3><div class="row-scroll" id="forgotten"></div></div>` : ""}
    ${stats.top_tags.length ? `<div class="glass strip rise" style="--d:12"><h3>Ваши темы</h3><div class="tagcloud" id="cloud"></div></div>` : ""}
  `;
  $$(".tile .num", root).forEach((el) => countUp(el, +el.dataset.n));
  $$("[data-go]", root).forEach((t) => (t.onclick = () => { emit("navigate", "library"); applyQuery({ view: t.dataset.go }); }));
  $$("[data-org]", root).forEach((b) => (b.onclick = () => (b.dataset.org === "triage" ? openTriage() : emit("navigate", "organize"))));
  renderHeat(p);
  strip("#recent", stats.recent);
  strip("#forgotten", stats.forgotten);
  pinStrip(pins.items);
  const cloud = $("#cloud");
  if (cloud) {
    cloud.innerHTML = stats.top_tags.map((t) => `<button data-t="${esc(t.name)}"># ${esc(t.name)} <span class="muted">${t.count}</span></button>`).join("");
    $$("button", cloud).forEach((b) => (b.onclick = () => { lib.tags = []; lib.ntags = []; toggleTag(b.dataset.t); }));
  }
  renderHero();
  renderChallenge();
}

function strip(sel, items) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = items.map((it, i) => `<div class="thumb" style="--i:${i}" data-id="${it.id}"><img src="${thumbUrl(it)}" alt="" loading="lazy">
    ${it.type === "video" ? `<span class="badge">▶ ${fmtDur(it.duration)}</span>` : ""}</div>`).join("");
  $$(".thumb", el).forEach((t) => (t.onclick = () => openViewer({
    items: items.map((x) => ({ ...x, tags: x.tags || [] })), cardEl: (id) => $(`${sel} .thumb[data-id="${id}"]`),
  }, +t.dataset.id, t)));
}

function pinStrip(pins) {
  const el = $("#pinsStrip");
  if (!el) return;
  el.innerHTML = pins.map((p, i) => `<div class="thumb" style="--i:${i}" data-id="${p.id}" title="${esc(p.title || p.board)}"><img src="/api/pinterest/pins/${p.id}/img" alt="" loading="lazy"></div>`).join("");
  const items = pins.map((p) => ({ id: p.id, external: true, type: "image", name: p.title || p.board, tags: [p.board],
    src: `/api/pinterest/pins/${p.id}/img?full=true`, thumb: `/api/pinterest/pins/${p.id}/img` }));
  $$(".thumb", el).forEach((t) => (t.onclick = () => openViewer({ items, cardEl: (id) => $(`#pinsStrip .thumb[data-id="${id}"]`) }, +t.dataset.id, t)));
  $("#toPins").onclick = (e) => { e.preventDefault(); emit("navigate", "pinterest"); };
}

function renderHeat(p) {
  const el = $("#heat");
  const start = new Date(p.start + "T00:00:00");
  const offset = (start.getDay() + 6) % 7; // выравниваем по понедельнику
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(`<i style="visibility:hidden"></i>`);
  const todayIso = new Date().toLocaleDateString("sv");
  for (let d = 0; d < 16 * 7; d++) {
    const dt = new Date(start); dt.setDate(start.getDate() + d);
    const iso = dt.toLocaleDateString("sv");
    if (iso > todayIso) break;
    const v = p.days[iso];
    const min = v ? v.seconds / 60 : 0;
    const l = !v ? 0 : min < 10 ? 1 : min < 25 ? 2 : min < 50 ? 3 : 4;
    cells.push(`<i data-l="${l}" style="--i:${d}" class="${iso === todayIso ? "now" : ""}" title="${dt.toLocaleDateString("ru-RU")}: ${v ? `${Math.round(min)} мин, набросков ${v.count}` : "без практики"}"></i>`);
  }
  el.innerHTML = cells.join("");
}

// ---------- референс дня

async function renderHero(reroll = false) {
  const hero = $("#hero");
  if (!hero) return;
  const t = await api(`/today?n=${todayN}`);
  const m = t.media;
  if (!m) { $(".content", hero).innerHTML = `<div><div class="eyebrow">Референс дня</div><h2>Добавьте картинки в библиотеку</h2></div>`; return; }
  const bg = $(".bg", hero);
  const img = new Image();
  img.src = `/api/file/${m.id}`;
  img.onload = () => {
    img.classList.add("loaded");
    $$("img", bg).forEach((o) => { if (o !== img) { o.style.opacity = 0; setTimeout(() => o.remove(), 900); } });
  };
  bg.appendChild(img);
  const content = $(".content", hero);
  content.innerHTML = `<div>
      <div class="eyebrow">${t.tag ? `Тема дня · #${esc(t.tag)}` : "Референс дня"}</div>
      <h2>${esc(m.name)}</h2>
      <div class="tags">${esc(t.reason || "")}</div>
    </div>
    <div class="actions">
      <button id="hOther" title="Другой референс">↻</button>
      ${t.tag ? `<button id="hTopic">Вся тема</button>` : ""}
      <button id="hOpen">Открыть</button>
      <button class="primary" id="hDraw">⏱ Рисовать 10 мин</button>
    </div>`;
  if (reroll) content.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 500, easing: "cubic-bezier(.16,1,.3,1)" });
  $("#hOther").onclick = () => { todayN++; renderHero(true); };
  if (t.tag) $("#hTopic").onclick = () => { lib.tags = []; lib.ntags = []; toggleTag(t.tag); };
  $("#hOpen").onclick = () => openViewer({ items: [m] }, m.id, hero);
  $("#hDraw").onclick = () => runSession({ ids: [m.id], dur: 600, kind: "gesture", prompt: t.tag ? `Тема дня: #${t.tag}` : "Референс дня", tag: t.tag, ctype: "daily" });
}

// ---------- «Нарисуй это» — из вашей библиотеки

const ICON = { tag: "🎯", series: "⚡", study: "🔍", redraw: "🔁", pin: "📌", none: "🏷️" };

async function renderChallenge(reroll = false) {
  const box = $("#challenge");
  if (!box) return;
  const ch = await api(`/challenge?n=${challengeN}`);
  if (ch.ctype === "none") {
    box.innerHTML = `<div class="eyebrow">🎲 Нарисуй это</div>
      <div class="prompt">Задания появятся из ваших тем</div>
      <p class="muted">${esc(ch.reason)}</p>
      <div class="foot"><button class="primary" id="cOrg">Разметить файлы</button></div>`;
    $("#cOrg").onclick = () => openTriage();
    return;
  }
  const words = ch.title.split(" ");
  const thumbs = ch.images.slice(0, 5).map((im) => im.pin ? `/api/pinterest/pins/${im.pin}/img` : `/api/thumb/${im.id}`);
  box.innerHTML = `
    <div class="eyebrow">${ICON[ch.ctype] || "🎲"} Нарисуй это</div>
    <div class="prompt">${words.map((w, i) => `<span class="w" style="--i:${i}">${w.startsWith("#") ? `<em>${esc(w)}</em>` : esc(w)}</span>`).join(" ")}</div>
    <div class="ctext">${esc(ch.text)}</div>
    <div class="rule">📏 Условие: <b>${esc(ch.rule)}</b></div>
    <div class="rule">⏱ Время: <b>${ch.per ? `${ch.images.length} × ${ch.per} с` : `${ch.minutes} мин`}</b></div>
    ${thumbs.length ? `<div class="ref">${thumbs.map((s) => `<img src="${s}" alt="">`).join("")}</div>` : ""}
    <div class="foot">
      <button id="cShuffle">🎲 Другое</button>
      <button class="primary" id="cGo">Начать</button>
    </div>`;
  if (reroll) box.animate([{ opacity: .4, transform: "scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "cubic-bezier(.16,1,.3,1)" });
  $("#cShuffle").onclick = () => { challengeN++; renderChallenge(true); };
  $("#cGo").onclick = () => startChallenge(ch);
}

/** Запуск задания (с главной или из командной панели). Без аргумента — берёт следующее задание. */
export async function startChallenge(ch = null) {
  if (!ch) ch = await api(`/challenge?n=${challengeN++}`);
  if (ch.ctype === "none") { emit("navigate", "organize"); return; }
  if (ch.ctype === "series") {
    return runSession({ ids: ch.images, dur: ch.per, kind: "gesture", prompt: ch.title, tag: ch.tag, ctype: ch.ctype });
  }
  runSession({ ids: ch.images, dur: ch.minutes * 60, kind: "challenge", prompt: ch.title, sub: `${ch.text} Условие: ${ch.rule}`, tag: ch.tag, ctype: ch.ctype });
}

on("practice-logged", () => { if ($('.page[data-page="today"]').classList.contains("active")) renderToday(); });
