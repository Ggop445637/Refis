// Тренировка: сессии набросков с таймером, задания «Нарисуй это», журнал практики.
import { $, $$, api, esc, store, toast, modal, fmtDur, fileUrl, confetti, emit, sleep, plural, reduced } from "./util.js";

const RING = 2 * Math.PI * 26;
const P = { list: [], i: 0, dur: 60, left: 0, paused: false, timer: null, mirror: false, gray: false,
  kind: "gesture", prompt: "", startedAt: 0, spent: 0, running: false, mediaId: null };

// ======================================================================= генератор заданий

const SUBJECTS = [
  "кисть руки, держащую предмет", "стопу в трёх ракурсах", "череп в 3/4", "драпировку на стуле", "персонажа в прыжке",
  "лицо снизу", "лицо сверху", "старое дерево", "кучевые облака", "уголок своей комнаты", "кошку, которая спит",
  "натюрморт из трёх предметов", "автопортрет", "человека, сидящего на полу", "бегущую фигуру", "профиль с эмоцией",
  "руки в жесте «стоп»", "складки рукава", "чашку с отражением", "улицу из окна", "стаю птиц", "дракона на камне",
  "персонажа с тяжёлой ношей", "двух людей в диалоге", "ухо и шею", "глаза с разными эмоциями", "силуэт города",
  "лес в тумане", "пару кроссовок", "лошадь в движении", "рыцаря в доспехах", "растение в горшке", "морскую волну",
  "старика с тростью", "танцора", "ребёнка, играющего на полу", "торс в повороте", "смятый лист бумаги", "свою ладонь",
];
const TWISTS = [
  "при контровом свете", "при свете свечи", "в жёстком свете сверху", "на закате", "ночью, один источник света",
  "в тумане", "снизу, с сильной перспективой", "сверху, вид с высоты", "в мягком рассеянном свете", "в холодной гамме",
  "в тёплой гамме", "с драматичными тенями", "в движении", "в ветреную погоду", "под дождём", "в зеркальном отражении",
  "с рим-лайтом", "в силуэте", "через стекло", "в утреннем свете",
];
const RULES = [
  "только 3 тона", "без ластика", "одной непрерывной линией", "сначала силуэт, потом детали", "не отрывая взгляд от референса",
  "только крупные формы", "без контурных линий", "левой рукой (или не ведущей)", "только прямые линии", "максимум 20 линий",
  "только светотень, без линий", "в двух цветах", "широкой кистью", "закончи за отведённое время, без доработок",
  "начни с самых тёмных пятен", "в квадратном формате", "маркером или ручкой", "сначала простые объёмы: шар, куб, цилиндр",
];
const MINUTES = [5, 10, 15, 20, 30, 45];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** Новое задание. tags — теги библиотеки (если хочется рисовать «своё»). */
export function generatePrompt({ tags = [], useTags = false, minutes = 0 } = {}) {
  const fromTag = useTags && tags.length && Math.random() < 0.7;
  const tag = fromTag ? pick(tags) : null;
  return {
    subject: tag ? tag.split("/").pop() : pick(SUBJECTS),
    tag,
    twist: Math.random() < 0.75 ? pick(TWISTS) : "",
    rule: pick(RULES),
    minutes: minutes || pick(MINUTES),
  };
}
export const promptText = (p) => `Нарисуй ${p.tag ? `на тему «${p.subject}»` : p.subject}${p.twist ? " " + p.twist : ""}`;

// ======================================================================= диалог тренировки

/**
 * Опции: ids — конкретные файлы; params — текущий фильтр библиотеки (URLSearchParams);
 * single — рисовать один референс.
 */
export function practiceDialog({ ids = null, params = null, total = 0, single = false } = {}) {
  const last = store("practice") || { dur: 60, count: 20, shuffle: true };
  if (single) last.dur = Math.max(last.dur, 300);
  const presets = [[30, "30 с"], [60, "1 мин"], [120, "2 мин"], [300, "5 мин"], [600, "10 мин"], [1200, "20 мин"], [0, "Без таймера"]];
  const src = ids ? (single ? "один выбранный референс" : `выбранные файлы (${ids.length})`) : `текущая подборка (${total} ${plural(total, "файл", "файла", "файлов")}, видео пропускаются)`;
  modal(`<h2>${single ? "Рисовать по референсу" : "Тренировка набросков"}</h2>
    <p>Источник: ${esc(src)}.</p>
    <div class="field"><label>Время на картинку</label>
      <div class="opts">${presets.map(([s, l]) => `<button data-d="${s}" class="${s === last.dur ? "on" : ""}">${l}</button>`).join("")}</div>
      <input type="number" id="pCustom" min="5" placeholder="или своё время в секундах" style="margin-top:6px"></div>
    ${single ? "" : `<div class="field"><label>Сколько картинок</label><input type="number" id="pCount" min="1" value="${last.count}"></div>
    <label class="check"><input type="checkbox" id="pShuffle"${last.shuffle ? " checked" : ""}> Перемешать</label>`}
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
        if (!list.length) return toast("В подборке нет картинок");
        close();
        runSession({ ids: list, dur, mirror: $("#pMirror", box).checked, gray: $("#pGray", box).checked, kind: "gesture" });
      };
    });
}

// ======================================================================= сессия

/** ids — картинки (может быть пусто, если задание без референса), prompt — текст задания. */
export async function runSession({ ids = [], dur = 60, mirror = false, gray = false, kind = "gesture", prompt = "", sub = "", mediaId = null }) {
  Object.assign(P, { list: ids.length ? ids : [null], i: 0, dur, paused: false, mirror, gray, kind, prompt, sub,
    spent: 0, done: 0, running: true, mediaId });
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
  const id = P.list[P.i];
  const stage = $("#pStage");
  stage.className = "stage" + (P.gray ? " gray" : "") + (P.mirror ? " mirror" : "");
  if (id) {
    stage.innerHTML = `${P.prompt ? `<div class="pprompt-mini">${esc(P.prompt)}${P.sub ? ` · <span class="muted">${esc(P.sub)}</span>` : ""}</div>` : ""}<img src="${fileUrl(id)}" alt="">`;
    const next = P.list[P.i + 1];
    if (next) new Image().src = fileUrl(next);
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
    await api("/practice", { method: "POST", body: { kind: P.kind, count: P.kind === "challenge" ? 1 : count, seconds: P.spent, prompt: P.prompt, media_id: P.mediaId } }).catch(() => {});
    emit("practice-logged");
  }
  const st = await api("/stats").catch(() => null);
  const streak = st?.practice?.streak || 0;
  $("#pStage").className = "stage";
  $("#practice").classList.add("finished");
  $("#pStage").innerHTML = `<div class="pdone"><div class="big">${P.spent > 10 ? "🎉" : "👋"}</div>
    <h2>${P.spent > 10 ? "Отличная работа!" : "Сессия завершена"}</h2>
    <p>${P.kind === "challenge" ? "Задание выполнено" : `Набросков: ${count}`} · ${fmtDur(P.spent)} за листом${streak ? ` · серия: ${streak} ${plural(streak, "день", "дня", "дней")} 🔥` : ""}</p>
    <button class="primary" id="pClose">Закрыть</button></div>`;
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
