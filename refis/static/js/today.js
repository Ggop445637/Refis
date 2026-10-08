// Страница «Сегодня»: референс дня, задание «Нарисуй это», статистика, календарь практики.
import { $, $$, api, esc, store, countUp, thumbUrl, fmtDur, plural, files, emit, on, toast } from "./util.js";
import { openViewer } from "./viewer.js";
import { practiceDialog, runSession, generatePrompt, promptText } from "./practice.js";
import { state as lib, folderDialog, toggleTag, applyQuery } from "./library.js";

let todayN = 0;
let prompt = null;
let stats = null;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
}

export async function renderToday() {
  const root = $("#today");
  stats = await api("/stats");
  const p = stats.practice;
  const date = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  if (!stats.total) {
    root.innerHTML = `<div class="hello rise"><h1>${greeting()}, <span>художник</span></h1><p>${date}</p></div>
      <div class="glass rise empty-state" style="--d:1">
        <div class="big">🎨</div><h2>Добро пожаловать в Refis</h2>
        <p>Добавьте папки с референсами, своими работами и уроками. Файлы останутся на месте: Refis построит каталог с превью, тегами и поиском.</p>
        <button class="primary" id="tAdd">＋ Добавить первую папку</button>
      </div>`;
    $("#tAdd").onclick = () => folderDialog();
    return;
  }
  root.innerHTML = `
    <div class="hello rise"><h1>${greeting()}, <span>художник</span></h1>
      <p>${date[0].toUpperCase() + date.slice(1)}${p.streak ? ` · серия ${p.streak} ${plural(p.streak, "день", "дня", "дней")} подряд 🔥` : " · самое время порисовать"}</p></div>
    <div class="t-grid">
      <div class="glass hero rise" style="--d:1" id="hero"><div class="bg"></div><div class="content"></div></div>
      <div class="glass challenge rise" style="--d:2" id="challenge"></div>
    </div>
    <div class="tiles">
      <div class="glass tile link rise" style="--d:3" data-go="all"><span class="ico">🖼️</span><div class="num" data-n="${stats.total}">0</div><div class="lbl">файлов в библиотеке</div></div>
      <div class="glass tile link rise" style="--d:4" data-go="untagged"><span class="ico">🏷️</span><div class="num" data-n="${stats.untagged}">0</div><div class="lbl">без тегов — разобрать →</div></div>
      <div class="glass tile flame rise" style="--d:5"><span class="ico">🔥</span><div class="num" data-n="${p.streak}">0</div><div class="lbl">${plural(p.streak, "день", "дня", "дней")} практики подряд</div></div>
      <div class="glass tile rise" style="--d:6"><span class="ico">⏱️</span><div class="num" data-n="${p.week_minutes}">0</div><div class="lbl">минут рисования за неделю</div></div>
    </div>
    <div class="glass heat rise" style="--d:7"><h3>Практика <small>последние 16 недель · ${p.total_sessions} ${plural(p.total_sessions, "сессия", "сессии", "сессий")}</small></h3><div class="heatgrid" id="heat"></div></div>
    ${stats.recent.length ? `<div class="glass strip rise" style="--d:8"><h3>Недавно добавленные <small>${files(stats.total)}</small></h3><div class="row-scroll" id="recent"></div></div>` : ""}
    ${stats.forgotten.length ? `<div class="glass strip rise" style="--d:9"><h3>Давно не открывали <small>вспомнить старое</small></h3><div class="row-scroll" id="forgotten"></div></div>` : ""}
    ${stats.top_tags.length ? `<div class="glass strip rise" style="--d:10"><h3>Ваши темы</h3><div class="tagcloud" id="cloud"></div></div>` : ""}
  `;
  $$(".tile .num", root).forEach((el) => countUp(el, +el.dataset.n));
  $$(".tile[data-go]", root).forEach((t) => (t.onclick = () => { emit("navigate", "library"); applyQuery({ view: t.dataset.go }); }));
  renderHeat(p);
  strip("#recent", stats.recent);
  strip("#forgotten", stats.forgotten);
  const cloud = $("#cloud");
  if (cloud) {
    cloud.innerHTML = stats.top_tags.map((t) => `<button data-t="${esc(t.name)}"># ${esc(t.name)} <span class="muted">${t.count}</span></button>`).join("");
    $$("button", cloud).forEach((b) => (b.onclick = () => { lib.tags = []; lib.ntags = []; toggleTag(b.dataset.t); }));
  }
  renderHero();
  renderChallenge(false);
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

function renderHeat(p) {
  const el = $("#heat");
  const start = new Date(p.start + "T00:00:00");
  // выравниваем по понедельнику
  const offset = (start.getDay() + 6) % 7;
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
  const { media: m } = await api(`/today?n=${todayN}`);
  if (!m) { hero.querySelector(".content").innerHTML = `<div><div class="eyebrow">Референс дня</div><h2>Добавьте картинки в библиотеку</h2></div>`; return; }
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
      <div class="eyebrow">${todayN ? "Случайный референс" : "Референс дня"}</div>
      <h2>${esc(m.name)}</h2>
      <div class="tags">${m.tags.length ? m.tags.map((t) => "#" + esc(t)).join("  ") : "без тегов"}</div>
    </div>
    <div class="actions">
      <button id="hOther" title="Другой">↻</button>
      <button id="hOpen">Открыть</button>
      <button class="primary" id="hDraw">⏱ Рисовать 10 мин</button>
    </div>`;
  if (reroll) content.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 500, easing: "cubic-bezier(.16,1,.3,1)" });
  $("#hOther").onclick = () => { todayN++; renderHero(true); };
  $("#hOpen").onclick = () => openViewer({ items: [m] }, m.id, hero);
  $("#hDraw").onclick = () => runSession({ ids: [m.id], dur: 600, kind: "gesture", prompt: "Референс дня", mediaId: m.id });
}

// ---------- «Нарисуй это»

function renderChallenge(reroll = true) {
  const box = $("#challenge");
  if (!box) return;
  const opt = store("challenge") || { useTags: true, withRef: true };
  if (!prompt || reroll) prompt = generatePrompt({ tags: stats?.top_tags.map((t) => t.name) || [], useTags: opt.useTags });
  const words = promptText(prompt).split(" ");
  const subjWords = new Set((prompt.tag ? `«${prompt.subject}»` : prompt.subject).split(" "));
  box.innerHTML = `
    <div class="eyebrow">🎲 Нарисуй это</div>
    <div class="prompt">${words.map((w, i) => `<span class="w" style="--i:${i}">${subjWords.has(w) && i > 0 ? `<em>${esc(w)}</em>` : esc(w)}</span>`).join(" ")}</div>
    <div class="rule">📏 Условие: <b>${esc(prompt.rule)}</b></div>
    <div class="rule">⏱ Время: <b>${prompt.minutes} мин</b></div>
    <div class="opts">
      <label class="check"><input type="checkbox" id="cTags"${opt.useTags ? " checked" : ""}> темы из моих тегов</label>
      <label class="check"><input type="checkbox" id="cRef"${opt.withRef ? " checked" : ""}> с референсом</label>
    </div>
    <div class="foot">
      <button id="cShuffle">🎲 Другое</button>
      <button class="primary" id="cGo">Начать</button>
    </div>`;
  const save = () => store("challenge", { useTags: $("#cTags").checked, withRef: $("#cRef").checked });
  $("#cTags").onchange = () => { save(); renderChallenge(true); };
  $("#cRef").onchange = save;
  $("#cShuffle").onclick = () => renderChallenge(true);
  $("#cGo").onclick = () => startChallenge(prompt, $("#cRef").checked);
}

export async function startChallenge(p = null, withRef = true) {
  p = p || generatePrompt({ tags: lib.allTags.slice(0, 30).map((t) => t.name), useTags: true });
  let ids = [];
  if (withRef) {
    const q = new URLSearchParams({ type: "image", sort: "random", limit: 1 });
    if (p.tag) q.set("tags", p.tag);
    else q.set("kind", "ref");
    let r = await api("/media?" + q);
    if (!r.items.length) { q.delete("tags"); q.delete("kind"); r = await api("/media?" + q); }
    ids = r.items.map((i) => i.id);
  }
  runSession({ ids, dur: p.minutes * 60, kind: "challenge", prompt: promptText(p), sub: "Условие: " + p.rule, mediaId: ids[0] || null });
}

on("practice-logged", () => { if ($('.page[data-page="today"]').classList.contains("active")) renderToday(); });
