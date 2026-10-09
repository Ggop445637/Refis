// Тренировка: сессии набросков с таймером, задания «Нарисуй это», журнал практики.
import { tr } from "./i18n.js";
import { $, $$, api, esc, store, toast, modal, fmtDur, fileUrl, confetti, emit, sleep, plural, reduced } from "./util.js";

const RING = 2 * Math.PI * 26;
const P = { list: [], i: 0, dur: 60, left: 0, paused: false, timer: null, mirror: false, gray: false,
  kind: "gesture", prompt: "", startedAt: 0, spent: 0, running: false, mediaId: null, tag: "", ctype: "" };

/** Картинка сессии: id файла библиотеки, {id} или {pin} (пин из Pinterest). */
function srcOf(x) {
  if (x == null) return null;
  if (typeof x === "number") return fileUrl(x);
  if (x.pin) return `/api/pinterest/pins/${x.pin}/img?full=true`;
  return fileUrl(x.id);
}

// ======================================================================= диалог тренировки

/**
 * Опции: ids — конкретные файлы; params — текущий фильтр библиотеки (URLSearchParams);
 * single — рисовать один референс.
 */
export function practiceDialog({ ids = null, params = null, total = 0, single = false } = {}) {
  const last = store("practice") || { dur: 60, count: 20, shuffle: true };
  if (single) last.dur = Math.max(last.dur, 300);
  const presets = [[30, tr("30 с")], [60, tr("1 мин")], [120, tr("2 мин")], [300, tr("5 мин")], [600, tr("10 мин")], [1200, tr("20 мин")], [0, tr("Без таймера")]];
  const src = ids ? (single ? tr("один выбранный референс") : `${tr("выбранные файлы")} (${ids.length})`) : `${tr("текущая подборка")} (${total} ${plural(total, "файл", "файла", "файлов")}, ${tr("видео пропускаются)")}`;
  modal(`<h2>${single ? tr("Рисовать по референсу") : tr("Тренировка набросков")}</h2>
    <p>${tr("Источник")}: ${esc(src)}.</p>
    <div class="field"><label>${tr("Время на картинку")}</label>
      <div class="opts">${presets.map(([s, l]) => `<button data-d="${s}" class="${s === last.dur ? "on" : ""}">${l}</button>`).join("")}</div>
      <input type="number" id="pCustom" min="5" placeholder="${tr("или своё время в секундах")}" style="margin-top:6px"></div>
    ${single ? "" : `<div class="field"><label>${tr("Сколько картинок")}</label><input type="number" id="pCount" min="1" value="${last.count}"></div>
    <label class="check"><input type="checkbox" id="pShuffle"${last.shuffle ? " checked" : ""}> ${tr("Перемешать")}</label>`}
    <label class="check"><input type="checkbox" id="pMirror"> ${tr("Отзеркалить")}</label>
    <label class="check"><input type="checkbox" id="pGray"> ${tr("Чёрно-белое")}</label>
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="pGo">${tr("Начать")}</button></div>`,
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
        const count = single ? 1 : Math.max(1, +$("#pCount", box).value || 20);
        const shuffle = single ? false : $("#pShuffle", box).checked;
        store("practice", { dur, count: single ? last.count : count, shuffle });
        let list;
        if (ids) {
          const info = await Promise.all(ids.slice(0, 500).map((id) => api(`/media/${id}`).catch(() => null)));
          list = info.filter((m) => m && m.type === "image").map((m) => m.id);
        } else {
          const p = new URLSearchParams(params || "");
          p.set("type", "image");
          if (shuffle) p.set("sort", "random");
          p.set("limit", 2000);
          list = (await api("/media?" + p)).items.map((i) => i.id);
        }
        if (shuffle) list.sort(() => Math.random() - 0.5);
        list = list.slice(0, count);
        if (!list.length) return toast(tr("В подборке нет картинок"));
        close();
        runSession({ ids: list, dur, mirror: $("#pMirror", box).checked, gray: $("#pGray", box).checked, kind: "gesture" });
      };
    });
}

// ======================================================================= сессия

/** ids — картинки (может быть пусто, если задание без референса), prompt — текст задания. */
export async function runSession({ ids = [], dur = 60, mirror = false, gray = false, kind = "gesture", prompt = "", sub = "",
  mediaId = null, tag = "", ctype = "" }) {
  const list = ids.map(srcOf).filter(Boolean);
  const first = ids[0];
  if (mediaId == null && first != null) mediaId = typeof first === "number" ? first : first.id ?? null;
  Object.assign(P, { list: list.length ? list : [null], i: 0, dur, paused: false, mirror, gray, kind, prompt, sub,
    spent: 0, done: 0, running: true, mediaId, tag, ctype });
  $("#practice").hidden = false;
  $("#practice").classList.remove("finished");
  $("#pRing").style.visibility = dur ? "" : "hidden";
  $("#pBar").style.strokeDasharray = RING;
  // отсчёт 3-2-1
  const stage = $("#pStage");
  stage.className = "stage";
  if (!reduced()) {
    for (const n of [3, 2, 1]) {
      if (!P.running) return;
      stage.innerHTML = `<div class="countdown">${n}</div>`;
      await sleep(700);
    }
  }
  if (!P.running) return;
  showCurrent();
  clearInterval(P.timer);
  P.last = performance.now();
  P.timer = setInterval(tick, 200);
}

function showCurrent() {
  const src = P.list[P.i];
  const stage = $("#pStage");
  stage.className = "stage" + (P.gray ? " gray" : "") + (P.mirror ? " mirror" : "");
  if (src) {
    stage.innerHTML = `${P.prompt ? `<div class="pprompt-mini">${esc(P.prompt)}${P.sub ? ` · <span class="muted">${esc(P.sub)}</span>` : ""}</div>` : ""}<img src="${esc(src)}" alt="">`;
    const next = P.list[P.i + 1];
    if (next) new Image().src = next;
  } else {
    stage.innerHTML = `<div class="pprompt">${esc(P.prompt)}${P.sub ? `<small>${esc(P.sub)}</small>` : ""}</div>`;
  }
  P.left = P.dur;
  $("#pCounter").textContent = P.list.length > 1 ? `${P.i + 1} / ${P.list.length}` : "";
  $('[data-p="pause"]').textContent = P.paused ? "▶" : "❚❚";
  $('[data-p="mirror"]').classList.toggle("on", P.mirror);
  $('[data-p="gray"]').classList.toggle("on", P.gray);
  $$('[data-p="prev"], [data-p="next"]').forEach((b) => (b.hidden = P.list.length < 2));
  renderTime();
}

function tick() {
  const now = performance.now();
  const dt = Math.min(1, (now - P.last) / 1000);
  P.last = now;
  if (P.paused) return;
  P.spent += dt;
  if (!P.dur) return renderTime();
  P.left -= dt;
  if (P.left <= 0) {
    P.done++;
    if (P.i + 1 >= P.list.length) return finish();
    P.i++;
    showCurrent();
  }
  renderTime();
}

function renderTime() {
  if (!P.dur) { $("#pTime").textContent = fmtDur(P.spent); return; }
  const s = Math.max(0, Math.ceil(P.left));
  $("#pTime").textContent = fmtDur(s);
  $("#pBar").style.strokeDashoffset = RING * (1 - Math.max(0, P.left) / P.dur);
  $("#pRing").classList.toggle("warn", s <= 5 && s > 0);
}

async function finish(early = false) {
  clearInterval(P.timer);
  P.running = false;
  const count = early ? P.done + (P.left < P.dur ? 1 : 0) : P.list.length;
  $("#pRing").classList.remove("warn");
  if (P.spent > 10) {
    await api("/practice", { method: "POST", body: { kind: P.kind, count: P.kind === "challenge" ? 1 : count, seconds: P.spent, prompt: P.prompt, media_id: P.mediaId, tag: P.tag, ctype: P.ctype } }).catch(() => {});
    emit("practice-logged");
  }
  const st = await api("/stats").catch(() => null);
  const streak = st?.practice?.streak || 0;
  $("#pStage").className = "stage";
  $("#practice").classList.add("finished");
  $("#pStage").innerHTML = `<div class="pdone"><div class="big">${P.spent > 10 ? "🎉" : "👋"}</div>
    <h2>${P.spent > 10 ? tr("Отличная работа!") : tr("Сессия завершена")}</h2>
    <p>${P.kind === "challenge" ? tr("Задание выполнено") : `${tr("Набросков")}: ${count}`} · ${fmtDur(P.spent)} ${tr("за листом")}${streak ? ` · ${tr("серия")}: ${streak} ${plural(streak, "день", "дня", "дней")} 🔥` : ""}</p>
    <button class="primary" id="pClose">${tr("Закрыть")}</button></div>`;
  $("#pClose").onclick = closePractice;
  $("#pTime").textContent = "";
  $("#pBar").style.strokeDashoffset = 0;
  if (P.spent > 10) confetti();
}

function closePractice() {
  P.running = false;
  clearInterval(P.timer);
  $("#practice").hidden = true;
}

function act(a) {
  switch (a) {
    case "prev": if (P.i > 0) { P.i--; showCurrent(); } break;
    case "next": if (P.i + 1 < P.list.length) { P.i++; P.done++; showCurrent(); } else finish(); break;
    case "pause": P.paused = !P.paused; $('[data-p="pause"]').textContent = P.paused ? "▶" : "❚❚"; break;
    case "mirror": P.mirror = !P.mirror; $("#pStage").classList.toggle("mirror", P.mirror); $('[data-p="mirror"]').classList.toggle("on", P.mirror); break;
    case "gray": P.gray = !P.gray; $("#pStage").classList.toggle("gray", P.gray); $('[data-p="gray"]').classList.toggle("on", P.gray); break;
    case "stop": P.running ? finish(true) : closePractice(); break;
  }
}
$("#practice").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) act(b.dataset.p); });

export const practiceOpen = () => !$("#practice").hidden;
export function practiceKey(e) {
  if (!practiceOpen()) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const map = { ArrowLeft: "prev", ArrowRight: "next", " ": "pause", h: "mirror", "р": "mirror", g: "gray", "п": "gray", Escape: "stop" };
  if (map[k]) act(map[k]);
  return true;
}
