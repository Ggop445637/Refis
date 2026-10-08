// «Порядок»: мастер организации библиотеки и быстрая разметка файлов без тегов.
import { $, $$, api, esc, toast, emit, on, files, plural, thumbUrl, fileUrl, KINDS, promptDialog, confetti, isTyping } from "./util.js";
import { folderDialog, loadFolders, loadTags, applyQuery } from "./library.js";

let health = null;
let dismissed = new Set();

const RING = 2 * Math.PI * 42;

export async function renderOrganize() {
  const root = $("#organize");
  health = await api("/organize/health");
  updateBadge(health);
  const h = health;
  root.innerHTML = `
    <header class="rise"><h1>Порядок в библиотеке</h1>
      <p class="muted">Сначала разберём файлы — тогда референс дня, задания и подборки будут строиться из ваших тем, а не наугад.</p></header>

    <div class="glass org-score rise" style="--d:1">
      <div class="ring"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="42"/>
        <circle class="bar" cx="50" cy="50" r="42" style="stroke-dasharray:${RING};stroke-dashoffset:${RING}"/></svg>
        <span><b id="orgScore">0</b>%</span></div>
      <div class="txt">
        <h2>${h.total ? (h.ready ? "Библиотека в хорошей форме" : "Есть что разобрать") : "Начнём с папок"}</h2>
        <p>${h.total ? `Размечено тегами ${files(h.total - h.untagged)} из ${h.total} · тегов: ${h.tags}` : "Добавьте папки, где лежат ваши референсы, арты и уроки."}
          ${h.dupes ? ` · дубликатов: ${h.dupes}` : ""}${h.missing ? ` · пропавших: ${h.missing}` : ""}</p>
        <div class="row">${nextStep(h)}</div>
      </div>
    </div>

    <section class="org-step glass rise" style="--d:2">
      <div class="num">1</div>
      <div class="body">
        <h3>Папки и их тип <small>${h.folders.length ? `${h.folders.length} ${plural(h.folders.length, "папка", "папки", "папок")}` : "пока нет"}</small></h3>
        <p class="muted">Тип помогает разделять референсы, ваши работы и уроки — задания «перерисуй свою работу» и «изучи урок» берутся отсюда.</p>
        <div class="folders">${h.folders.map((f) => `
          <div class="frow" data-id="${f.id}">
            <span class="path" title="${esc(f.path)}">${esc(f.path)}</span>
            <span class="muted">${files(f.count)}${f.untagged ? ` · без тегов ${f.untagged}` : ""}</span>
            <select data-kind>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === f.kind ? " selected" : ""}>${v}</option>`).join("")}</select>
            ${f.untagged ? `<button class="mini" data-tri="${f.id}">Разметить</button>` : ""}
          </div>`).join("")}</div>
        <div class="row"><button id="orgDiscover" class="primary">🔍 Найти папки с картинками</button><button id="orgAdd">＋ Указать папку вручную</button></div>
        <div id="orgFound"></div>
      </div>
    </section>

    <section class="org-step glass rise" style="--d:3">
      <div class="num">2</div>
      <div class="body">
        <h3>Теги из имён файлов и папок <small id="sugCount"></small></h3>
        <p class="muted">Refis нашёл повторяющиеся слова в названиях. Примените подходящие — одним кликом тег встанет на все такие файлы. ✎ — поправить название перед применением.</p>
        <div class="sugs" id="sugs"><div class="hint">Ищу…</div></div>
      </div>
    </section>

    <section class="org-step glass rise" style="--d:4">
      <div class="num">3</div>
      <div class="body">
        <h3>Быстрая разметка <small>${h.untagged ? `без тегов: ${h.untagged}` : "всё размечено ✓"}</small></h3>
        <p class="muted">Файлы показываются по одному, рядом — подсказки тегов (из соседей по папке, имени файла, популярные). Клавиши <kbd>1</kbd>–<kbd>9</kbd> ставят подсказки, <kbd>Enter</kbd> — дальше.</p>
        <div class="row"><button class="primary" id="orgTriage" ${h.untagged ? "" : "disabled"}>🏷 Начать разметку</button></div>
      </div>
    </section>

    <section class="org-step glass rise" style="--d:5">
      <div class="num">4</div>
      <div class="body">
        <h3>Уборка</h3>
        <div class="row">
          <button data-view="dupes" ${h.dupes ? "" : "disabled"}>⧉ Дубликаты (${h.dupes})</button>
          <button data-view="missing" ${h.missing ? "" : "disabled"}>Пропавшие файлы (${h.missing})</button>
          <button data-view="untagged" ${h.untagged ? "" : "disabled"}>Без тегов в библиотеке (${h.untagged})</button>
        </div>
      </div>
    </section>

    <section class="org-step glass rise" style="--d:6">
      <div class="num">5</div>
      <div class="body">
        <h3>Pinterest <small>${h.pin_sources ? `подключено: ${h.pin_sources}` : "необязательно"}</small></h3>
        <p class="muted">Подключите свои доски — новые пины будут появляться в Refis, их можно сохранять в библиотеку с тегом доски и использовать в заданиях.</p>
        <div class="row"><button id="orgPin">Открыть Pinterest</button></div>
      </div>
    </section>`;

  requestAnimationFrame(() => {
    const bar = $(".org-score .bar", root);
    if (bar) bar.style.strokeDashoffset = RING * (1 - h.score / 100);
    animateNumber($("#orgScore"), h.score);
  });
  $$(".frow select[data-kind]", root).forEach((sel) => (sel.onchange = async () => {
    const id = +sel.closest(".frow").dataset.id;
    await api(`/folders/${id}`, { method: "PATCH", body: { kind: sel.value, apply_kind: true } });
    toast(`Тип папки: ${KINDS[sel.value]} — применён ко всем её файлам`);
    loadFolders();
  }));
  $$("[data-tri]", root).forEach((b) => (b.onclick = () => openTriage(+b.dataset.tri)));
  $("#orgDiscover").onclick = discover;
  $("#orgAdd").onclick = () => folderDialog(() => setTimeout(renderOrganize, 1200));
  $("#orgTriage").onclick = () => openTriage();
  $("#orgPin").onclick = () => emit("navigate", "pinterest");
  $$("[data-view]", root).forEach((b) => (b.onclick = () => { emit("navigate", "library"); applyQuery({ view: b.dataset.view }); }));
  $$("[data-go]", root).forEach((b) => (b.onclick = () => runStep(b.dataset.go)));
  loadSuggestions();
}

function nextStep(h) {
  if (!h.folders.length) return `<button class="primary" data-go="discover">🔍 Найти папки с картинками</button>`;
  if (h.untagged && h.tagged_share < 0.5) return `<button class="primary" data-go="suggest">✨ Применить предложенные теги</button><button data-go="triage">🏷 Быстрая разметка</button>`;
  if (h.untagged) return `<button class="primary" data-go="triage">🏷 Разметить оставшиеся ${h.untagged}</button>`;
  return `<button class="primary" data-go="today">Перейти к практике →</button>`;
}
function runStep(s) {
  if (s === "discover") discover();
  if (s === "triage") openTriage();
  if (s === "today") emit("navigate", "today");
  if (s === "suggest") $("#sugs")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function animateNumber(el, to) {
  if (!el) return;
  const t0 = performance.now();
  (function f(t) {
    const k = Math.min(1, (t - t0) / 1100);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 4)));
    if (k < 1) requestAnimationFrame(f);
  })(t0);
}

export function updateBadge(h) {
  const b = $("#orgBadge");
  if (b) b.textContent = h && h.total && h.untagged ? h.untagged : "";
}

// ---------- поиск папок на диске

async function discover() {
  const box = $("#orgFound");
  if (!box) { emit("navigate", "organize"); return setTimeout(discover, 400); }
  box.innerHTML = `<div class="hint scanning">Ищу папки с картинками в «Изображениях», «Загрузках», на рабочем столе и других дисках…</div>`;
  const found = await api("/organize/discover");
  if (!found.length) {
    box.innerHTML = `<p class="muted">Новых папок с картинками не нашлось. Если ваши файлы лежат в другом месте — нажмите «Указать папку вручную».</p>`;
    return;
  }
  box.innerHTML = `<div class="found">${found.map((f, i) => `
    <label class="frow found-row" style="--i:${i}">
      <input type="checkbox" data-i="${i}" ${f.arty || f.images > 30 ? "checked" : ""}>
      <span class="path" title="${esc(f.path)}">${esc(f.path)}</span>
      <span class="muted">${f.images} фото${f.videos ? ` · ${f.videos} видео` : ""}</span>
      <select data-i="${i}">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === f.kind ? " selected" : ""}>${v}</option>`).join("")}</select>
    </label>`).join("")}</div>
    <div class="row"><button class="primary" id="foundAdd">Добавить отмеченные</button><span class="hint">Файлы останутся на месте</span></div>`;
  $("#foundAdd").onclick = async () => {
    const picks = $$("#orgFound input[type=checkbox]:checked").map((c) => +c.dataset.i);
    if (!picks.length) return toast("Отметьте хотя бы одну папку");
    let ok = 0;
    for (const i of picks) {
      const kind = $(`#orgFound select[data-i="${i}"]`).value;
      try { await api("/folders", { method: "POST", body: { path: found[i].path, kind, auto_tags: true } }); ok++; } catch {}
    }
    toast(`Добавлено папок: ${ok} — сканирую…`);
    await loadFolders();
    emit("poll");
    setTimeout(renderOrganize, 1500);
  };
}

// ---------- предложения тегов

async function loadSuggestions() {
  const box = $("#sugs");
  const list = (await api("/organize/tag-suggestions")).filter((s) => !dismissed.has(s.tag));
  if (!box) return;
  $("#sugCount").textContent = list.length ? `${list.length}` : "";
  if (!list.length) {
    box.innerHTML = `<div class="hint">Новых предложений нет — всё, что можно было понять из названий, уже размечено.</div>`;
    return;
  }
  box.innerHTML = list.map((s, i) => `
    <div class="sug" style="--i:${i}" data-i="${i}">
      <div class="thumbs">${s.sample.map((id) => `<img src="/api/thumb/${id}" alt="" loading="lazy">`).join("")}</div>
      <div class="meta"><b>#${esc(s.tag)}</b><span class="muted">${files(s.count)} · ${s.from === "folder" ? "из папок" : "из имён"}${s.exists ? " · тег уже есть" : ""}</span></div>
      <div class="acts"><button class="mini primary" data-a="ok" title="Применить">✓</button><button class="mini" data-a="edit" title="Изменить название">✎</button><button class="mini ghost" data-a="no" title="Не подходит">✕</button></div>
    </div>`).join("") + (list.length > 1 ? `<div class="row" style="width:100%"><button id="sugAll">Применить все ${list.length}</button></div>` : "");
  const apply = async (s, name, el) => {
    await api("/organize/apply", { method: "POST", body: { tag: name || s.tag, ids: s.ids } });
    el?.classList.add("gone");
    setTimeout(() => el?.remove(), 350);
    toast(`#${name || s.tag} → ${files(s.ids.length)}`);
  };
  $$(".sug", box).forEach((el) => {
    const s = list[+el.dataset.i];
    el.querySelector('[data-a="ok"]').onclick = () => apply(s, null, el).then(afterApply);
    el.querySelector('[data-a="edit"]').onclick = () => promptDialog("Название тега", "Например, переведите «hand» в «руки» или сделайте вложенным: «анатомия/руки».", s.tag,
      (name) => apply(s, name, el).then(afterApply));
    el.querySelector('[data-a="no"]').onclick = () => { dismissed.add(s.tag); el.classList.add("gone"); setTimeout(() => el.remove(), 350); };
  });
  const all = $("#sugAll");
  if (all) all.onclick = async () => {
    for (const s of list) if (!dismissed.has(s.tag)) await api("/organize/apply", { method: "POST", body: { tag: s.tag, ids: s.ids } });
    toast(`Применено тегов: ${list.length}`);
    afterApply();
  };
}
let applyTimer;
function afterApply() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => { loadTags(); renderOrganize(); }, 700);
}

// ======================================================================= быстрая разметка

const T = { list: [], i: 0, recent: [], sugg: [], cur: null };

export async function openTriage(folder = 0) {
  T.list = await api(`/organize/triage${folder ? `?folder=${folder}` : ""}`);
  if (!T.list.length) return toast("Файлов без тегов нет 🎉");
  T.i = 0;
  T.done = 0;
  $("#triage").hidden = false;
  showTriage();
}
export const triageOpen = () => !$("#triage").hidden;

async function showTriage() {
  if (T.i >= T.list.length) return finishTriage();
  const it = T.list[T.i];
  const m = await api(`/media/${it.id}`);
  T.cur = m;
  $("#triCount").textContent = `${T.i + 1} / ${T.list.length}`;
  $("#triBar").style.width = (100 * T.i / T.list.length) + "%";
  const stage = $("#triStage");
  stage.innerHTML = m.type === "video"
    ? `<video src="${fileUrl(m.id)}" autoplay muted loop playsinline></video>`
    : `<img src="${thumbUrl(m)}" alt=""><img class="hi" src="${fileUrl(m.id)}" alt="" onload="this.classList.add('on')">`;
  const sugg = await api(`/organize/suggest/${m.id}`);
  // недавно использованные в этой сессии — первыми
  const merged = [...T.recent.map((t) => ({ tag: t, why: "недавно" })), ...sugg].filter((s, i, a) => a.findIndex((x) => x.tag === s.tag) === i).slice(0, 9);
  T.sugg = merged;
  const folder = m.path.split(/[\\/]/).slice(-3, -1).join(" / ");
  $("#triPanel").innerHTML = `
    <div class="dname">${esc(m.name)}<span class="muted">.${esc(m.ext)}</span></div>
    <div class="hint">📁 ${esc(folder)}</div>
    <div class="field"><label>Теги</label><div class="tagedit" id="triTags"></div></div>
    <div class="field"><label>Подсказки — клавиши 1–9</label><div class="tri-sugs">${merged.map((s, i) =>
      `<button data-t="${esc(s.tag)}"><kbd>${i + 1}</kbd> ${esc(s.tag)} <small>${esc(s.why)}</small></button>`).join("") || '<span class="hint">подсказок нет — введите свой тег</span>'}</div></div>
    <div class="field"><label>Тип</label><div class="seg" id="triKind">${Object.entries(KINDS).map(([k, v]) =>
      `<button data-k="${k}" class="${k === m.kind ? "on" : ""}">${v}</button>`).join("")}</div></div>
    <div class="row tri-nav">
      <button id="triPrev" ${T.i ? "" : "disabled"}>← Назад</button>
      <button id="triSkip" class="ghost">Пропустить</button>
      <button id="triNext" class="primary">Дальше →</button>
    </div>
    <div class="hint">Enter в пустом поле — дальше · Esc — закончить</div>`;
  renderTriTags();
  $$(".tri-sugs button").forEach((b) => (b.onclick = () => toggleTriTag(b.dataset.t)));
  $$("#triKind button").forEach((b) => (b.onclick = async () => {
    await api(`/media/${m.id}`, { method: "PATCH", body: { kind: b.dataset.k } });
    m.kind = b.dataset.k;
    $$("#triKind button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("#triPrev").onclick = () => { T.i = Math.max(0, T.i - 1); showTriage(); };
  $("#triSkip").onclick = () => { T.i++; showTriage(); };
  $("#triNext").onclick = next;
  setTimeout(() => $("#triTags input")?.focus(), 30);
}

function renderTriTags() {
  const m = T.cur;
  const box = $("#triTags");
  box.innerHTML = m.tags.map((t) => `<span class="chip">${esc(t)}<button data-t="${esc(t)}">×</button></span>`).join("") +
    `<input list="tagOptions" placeholder="${m.tags.length ? "" : "свой тег и Enter"}">`;
  $$(".chip button", box).forEach((b) => (b.onclick = () => toggleTriTag(b.dataset.t)));
  $$(".tri-sugs button").forEach((b) => b.classList.toggle("on", m.tags.includes(b.dataset.t)));
  const input = $("input", box);
  input.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const v = input.value.trim().replace(/^#/, "").toLowerCase();
      if (v) { input.value = ""; toggleTriTag(v, true); }
      else if (e.key === "Enter") next();
    } else if (e.key === "Backspace" && !input.value && m.tags.length) {
      toggleTriTag(m.tags[m.tags.length - 1]);
    } else if (/^[1-9]$/.test(e.key) && !input.value) {
      e.preventDefault();
      const s = T.sugg[+e.key - 1];
      if (s) toggleTriTag(s.tag);
    }
  };
  input.focus();
}

async function toggleTriTag(tag, forceOn = false) {
  const m = T.cur;
  if (m.tags.includes(tag) && !forceOn) m.tags = m.tags.filter((t) => t !== tag);
  else if (!m.tags.includes(tag)) {
    m.tags.push(tag);
    T.recent = [tag, ...T.recent.filter((t) => t !== tag)].slice(0, 4);
  }
  renderTriTags();
  await api(`/media/${m.id}`, { method: "PATCH", body: { tags: m.tags } });
}

function next() {
  if (T.cur?.tags.length) T.done++;
  T.i++;
  const st = $("#triStage");
  st.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-40px)" }], { duration: 160, easing: "ease-in" })
    .onfinish = showTriage;
}

function finishTriage() {
  $("#triBar").style.width = "100%";
  $("#triStage").innerHTML = `<div class="pdone"><div class="big">🎉</div><h2>Разметка закончена</h2><p>Размечено: ${files(T.done)}</p>
    <button class="primary" id="triDone">Закрыть</button></div>`;
  $("#triPanel").innerHTML = "";
  $("#triDone").onclick = closeTriage;
  if (T.done) confetti();
}

function closeTriage() {
  $("#triage").hidden = true;
  loadTags();
  emit("library-reload");
  emit("organize-changed");
}
$("#triClose").onclick = closeTriage;

export function triageKey(e) {
  if (!triageOpen()) return false;
  if (e.key === "Escape") { closeTriage(); return true; }
  if (isTyping(e)) return false;
  if (e.key === "ArrowRight") { next(); return true; }
  if (e.key === "ArrowLeft") { T.i = Math.max(0, T.i - 1); showTriage(); return true; }
  if (/^[1-9]$/.test(e.key)) { const s = T.sugg[+e.key - 1]; if (s) toggleTriTag(s.tag); return true; }
  return true;
}

on("organize-changed", () => { if ($('.page[data-page="organize"]').classList.contains("active")) renderOrganize(); });
