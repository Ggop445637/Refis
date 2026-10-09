// Профиль: статистика практики, темы, достижения, лента своих работ.
import { $, $$, api, esc, countUp, plural, emit, thumbUrl, toast } from "./util.js";
import { openViewer } from "./viewer.js";
import { state as lib, toggleTag } from "./library.js";
import { settings, applySettings } from "./settings.js";

const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function hm(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} ч ${m ? m + " мин" : ""}`.trim() : `${m} мин`;
}

export async function renderProfile() {
  const root = $("#profile");
  const p = await api("/profile");
  const t = p.totals;
  const name = settings.name || "";
  const since = t.since ? new Date(t.since * 1000).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) : null;
  const done = p.achievements.filter((a) => a.done).length;
  root.innerHTML = `
    <header class="rise prof-head">
      <div class="avatar">${esc((name || "Х")[0].toUpperCase())}</div>
      <div>
        <input class="prof-name" id="profName" value="${esc(name)}" placeholder="Как к вам обращаться?" maxlength="40">
        <p class="muted">${since ? `Практикуется с ${since}` : "Здесь появится ваш прогресс после первой тренировки"} · достижений ${done} из ${p.achievements.length}</p>
      </div>
    </header>

    <div class="tiles">
      <div class="glass tile rise" style="--d:1"><span class="ico">⏱️</span><div class="num" data-n="${Math.round(t.minutes / 60)}">0</div><div class="lbl">${plural(Math.round(t.minutes / 60), "час", "часа", "часов")} за листом · ${t.sessions} ${plural(t.sessions, "сессия", "сессии", "сессий")}</div></div>
      <div class="glass tile rise" style="--d:2"><span class="ico">✏️</span><div class="num" data-n="${t.sketches}">0</div><div class="lbl">набросков · ${t.challenges} ${plural(t.challenges, "задание", "задания", "заданий")}</div></div>
      <div class="glass tile flame rise" style="--d:3"><span class="ico">🔥</span><div class="num" data-n="${t.streak}">0</div><div class="lbl">дней подряд сейчас · лучшая серия ${t.best_streak}</div></div>
      <div class="glass tile rise" style="--d:4"><span class="ico">📅</span><div class="num" data-n="${t.days}">0</div><div class="lbl">${plural(t.days, "день", "дня", "дней")} с практикой</div></div>
    </div>

    <section class="glass chart-card rise" style="--d:5">
      <h3>Минуты рисования по неделям <small>последние полгода</small></h3>
      <div class="bars" id="weekChart"></div>
      <details class="as-table"><summary>Показать таблицей</summary>
        <table><thead><tr><th>Неделя с</th><th>Минут</th><th>Сессий</th></tr></thead><tbody>
        ${p.weeks.filter((w) => w.sessions).reverse().map((w) => `<tr><td>${new Date(w.start).toLocaleDateString("ru-RU")}</td><td>${w.minutes}</td><td>${w.sessions}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">пока пусто</td></tr>`}
        </tbody></table></details>
    </section>

    <div class="two-col">
      <section class="glass chart-card rise" style="--d:6">
        <h3>Любимые темы <small>минуты практики</small></h3>
        ${p.topics.length ? `<div class="hbars">${p.topics.map((x, i) => `
          <div class="hbar" style="--i:${i}" data-tag="${esc(x.tag)}" title="${x.sessions} ${plural(x.sessions, "сессия", "сессии", "сессий")}">
            <span class="name">#${esc(x.tag)}</span><span class="track"><i style="--w:${(100 * x.minutes) / Math.max(...p.topics.map((y) => y.minutes), 1)}%"></i></span><span class="val">${hm(x.minutes)}</span></div>`).join("")}</div>`
          : `<p class="muted">Темы появятся, когда вы порисуете по заданиям или референсу дня.</p>`}
      </section>
      <section class="glass chart-card rise" style="--d:7">
        <h3>Давно не практиковали <small>больше месяца</small></h3>
        ${p.neglected.length ? `<div class="tagcloud">${p.neglected.map((x) => `<button data-tag="${esc(x.tag)}">#${esc(x.tag)} <span class="muted">${x.count}</span></button>`).join("")}</div>
          <p class="hint">Эти темы чаще попадают в «Тему дня» и задания.</p>`
          : `<p class="muted">Вы прошлись по всем крупным темам за последний месяц 👏</p>`}
      </section>
    </div>

    <section class="glass chart-card rise" style="--d:8">
      <h3>Достижения <small>${done} из ${p.achievements.length}</small></h3>
      <div class="achs">${p.achievements.map((a, i) => `
        <div class="ach ${a.done ? "done" : ""}" style="--i:${i};--p:${Math.round(a.progress * 100)}" title="${esc(a.desc)}">
          <div class="medal"><span>${a.icon}</span></div>
          <b>${esc(a.title)}</b><small>${a.done ? "получено" : `${a.value} / ${a.goal}`}</small>
        </div>`).join("")}</div>
    </section>

    ${p.own.length ? `<section class="glass strip rise" style="--d:9"><h3>Мои работы <small>${p.library.own} · по дате файла</small></h3>
      <div class="own-line" id="ownLine">${groupByMonth(p.own)}</div></section>` : ""}

    <section class="glass chart-card rise" style="--d:10">
      <h3>Последние сессии</h3>
      ${p.recent.length ? `<div class="sessions">${p.recent.map((r) => `<div class="sess"><span>${new Date(r.ts * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        <b>${esc(r.prompt || (r.kind === "gesture" ? "Наброски" : "Задание"))}</b>${r.tag ? `<span class="muted">#${esc(r.tag)}</span>` : ""}
        <span class="muted">${r.kind === "gesture" ? `${r.count} шт · ` : ""}${hm(r.minutes)}</span></div>`).join("")}</div>`
        : `<p class="muted">Пока ни одной — начните с «Нарисуй это» на странице «Сегодня».</p>`}
    </section>`;

  $$(".tile .num", root).forEach((el) => countUp(el, +el.dataset.n));
  weekChart($("#weekChart"), p.weeks);
  $$("[data-tag]", root).forEach((b) => (b.onclick = () => { lib.tags = []; lib.ntags = []; toggleTag(b.dataset.tag); }));
  const nameInput = $("#profName");
  nameInput.onchange = async () => {
    applySettings(await api("/settings", { method: "PATCH", body: { name: nameInput.value.trim() } }));
    $(".avatar", root).textContent = (nameInput.value.trim() || "Х")[0].toUpperCase();
    toast("Имя сохранено");
  };
  nameInput.onkeydown = (e) => { if (e.key === "Enter") nameInput.blur(); };
  $$("#ownLine .thumb").forEach((el) => (el.onclick = () => openViewer({
    items: p.own.map((x) => ({ ...x, tags: [] })), cardEl: (id) => $(`#ownLine .thumb[data-id="${id}"]`),
  }, +el.dataset.id, el)));
}

function groupByMonth(items) {
  const groups = new Map();
  items.forEach((it) => {
    const d = new Date(it.mtime * 1000);
    const key = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  });
  let i = 0;
  return [...groups].map(([k, list]) => `<div class="own-month"><span class="m">${k}</span><div class="row-scroll">${list.map((it) =>
    `<div class="thumb" style="--i:${i++}" data-id="${it.id}"><img src="${thumbUrl(it)}" alt="" loading="lazy"></div>`).join("")}</div></div>`).join("");
}

/** Столбики по неделям: один ряд данных, подсказка при наведении, подписи месяцев. */
function weekChart(el, weeks) {
  const W = 760, H = 180, padL = 34, padB = 22, padT = 8;
  const max = Math.max(30, ...weeks.map((w) => w.minutes));
  const nice = Math.ceil(max / 30) * 30;
  const bw = (W - padL) / weeks.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / nice);
  const grid = [0, nice / 2, nice].map((v) => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
    <text x="${padL - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`).join("");
  let lastMonth = -1;
  const bars = weeks.map((w, i) => {
    const d = new Date(w.start);
    const x = padL + i * bw + 1, h = Math.max(0, y(0) - y(w.minutes));
    const label = d.getMonth() !== lastMonth ? `<text x="${x}" y="${H - 6}" class="axis">${MONTHS[d.getMonth()]}</text>` : "";
    lastMonth = d.getMonth();
    const r = Math.min(4, h / 2, (bw - 2) / 2);
    const path = h > 0 ? `<path class="bar" style="--i:${i}" d="M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>` : "";
    return `${label}<g data-i="${i}">${path}<rect class="hit" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}"/></g>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${grid}${bars}</svg><div class="tip" hidden></div>`;
  const tip = $(".tip", el);
  $$("g[data-i]", el).forEach((g) => {
    g.onmouseenter = () => {
      const w = weeks[+g.dataset.i];
      const d = new Date(w.start);
      tip.innerHTML = `<b>${w.minutes} мин</b><br>неделя с ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}<br>${w.sessions} ${plural(w.sessions, "сессия", "сессии", "сессий")}`;
      tip.hidden = false;
      const r = g.getBoundingClientRect(), er = el.getBoundingClientRect();
      tip.style.left = Math.min(er.width - 150, Math.max(0, r.left - er.left + r.width / 2 - 70)) + "px";
      g.classList.add("hover");
    };
    g.onmouseleave = () => { tip.hidden = true; g.classList.remove("hover"); };
  });
}

export const goProfile = () => emit("navigate", "profile");
