// Разделы («Референсы», «Мои работы»… и свои): в боковой панели, создание, правка, удаление, порядок, экспорт.
import { tr } from "./i18n.js";
import { $, $$, api, esc, toast, menu, modal, emit, files, KINDS, KIND_PLURAL, SECTIONS, applySections } from "./util.js";
import { state, load, loadTags, loadFolders, setView, renderDetails, reloadKeepSelection } from "./library.js";
import { exportPackDialog } from "./packs.js";
import { DRAG_TYPE } from "./folders.js";

const PALETTE = ["#6aa8ff", "#ffb35c", "#5ee6a0", "#b48cff", "#ff6b8b", "#4fd1e0", "#f2d45c", "#a3e36b", "#ff8a5c", "#c0c4d0"];

export async function loadSections() {
  applySections(await api("/sections"));
  renderSectionsNav();
}

// после любых изменений: подписи и цвета по всему интерфейсу
async function refresh() {
  await loadSections();
  await Promise.all([loadFolders(), reloadKeepSelection()]);
  renderDetails();
}

export function renderSectionsNav() {
  const nav = $("#views");
  $$("[data-section], [data-add-section]", nav).forEach((b) => b.remove());
  const html = SECTIONS.map((s) => `<button data-view="${esc(s.key)}" data-section><i class="dot k-${esc(s.key)}"></i>${esc(KIND_PLURAL[s.key])}</button>`).join("")
    + `<button data-add-section class="addsec" title="${tr("Свой раздел: например, «Анатомия» или «Пейзажи»")}">＋ ${tr("Новый раздел")}</button>`;
  $('[data-view="all"]', nav).insertAdjacentHTML("afterend", html);
  if (!["all", "fav", "untagged", "dupes", "missing"].includes(state.view) && !KINDS[state.view]) state.view = "all";
  setView(state.view);
}

const nav = $("#views");
nav.addEventListener("click", (e) => {
  if (e.target.closest("[data-add-section]")) sectionDialog();
});
nav.addEventListener("contextmenu", (e) => {
  const b = e.target.closest("[data-section]");
  if (!b) return;
  e.preventDefault();
  const s = SECTIONS.find((x) => x.key === b.dataset.view);
  const i = SECTIONS.indexOf(s);
  menu(e, [
    [`✎ ${tr("Переименовать и цвет…")}`, () => sectionDialog(s)],
    [`📦 ${tr("Экспорт раздела…")}`, () => exportPackDialog({ kind: s.key, name: KIND_PLURAL[s.key] })],
    i > 0 && [`↑ ${tr("Выше")}`, () => reorder(s.key, -1)],
    i < SECTIONS.length - 1 && [`↓ ${tr("Ниже")}`, () => reorder(s.key, 1)],
    "-",
    [`＋ ${tr("Новый раздел…")}`, () => sectionDialog()],
    s.deletable ? [`🗑 ${tr("Удалить раздел…")}`, () => deleteDialog(s)] : null,
  ]);
});

async function reorder(key, d) {
  const keys = SECTIONS.map((s) => s.key);
  const i = keys.indexOf(key);
  [keys[i], keys[i + d]] = [keys[i + d], keys[i]];
  applySections(await api("/sections/order", { method: "PUT", body: { keys } }));
  renderSectionsNav();
}

// перетащить карточки на раздел — перенести их туда
nav.addEventListener("dragover", (e) => {
  const b = e.target.closest("[data-section]");
  if (!b || ![...(e.dataTransfer?.types || [])].includes(DRAG_TYPE)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  $$("#views .drop").forEach((x) => x !== b && x.classList.remove("drop"));
  b.classList.add("drop");
});
nav.addEventListener("dragleave", (e) => {
  const b = e.target.closest("[data-section]");
  if (b && !b.contains(e.relatedTarget)) b.classList.remove("drop");
});
nav.addEventListener("drop", async (e) => {
  const b = e.target.closest("[data-section]");
  if (!b || ![...(e.dataTransfer?.types || [])].includes(DRAG_TYPE)) return;
  e.preventDefault();
  b.classList.remove("drop");
  const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || "[]");
  await moveToSection(ids, b.dataset.view);
});

export async function moveToSection(ids, key) {
  if (!ids.length) return;
  await api("/media/bulk", { method: "POST", body: { ids, kind: key } });
  toast(`${tr("В раздел")} «${KIND_PLURAL[key]}»: ${files(ids.length)}`);
  await reloadKeepSelection();
  renderDetails();
}

// ---------- создание и правка

function swatches(cur) {
  return `<div class="colorpick" id="sColors">${PALETTE.map((c) =>
    `<button type="button" data-c="${c}" class="${c === cur ? "on" : ""}" style="background:${c}" title="${c}"></button>`).join("")}
    <label class="custom" title="${tr("Свой цвет")}"><input type="color" id="sCustom" value="${cur || "#888888"}"></label></div>`;
}

export function sectionDialog(s = null) {
  const sel = [...state.selected];
  const used = new Set(SECTIONS.map((x) => x.color));
  let color = s?.color || PALETTE.find((c) => !used.has(c)) || PALETTE[0];
  modal(`<h2>${s ? tr("Раздел") : `＋ ${tr("Новый раздел")}`}</h2>
    ${s ? "" : `<p class="hint">${tr("Разделы — это верхний уровень библиотеки, как «Референсы» и «Мои работы». Файл лежит в одном разделе; теги и папки остаются как были.")}</p>`}
    <div class="field"><label>${tr("Название")}</label><input type="text" id="sName" value="${esc(s ? KIND_PLURAL[s.key] : "")}" placeholder="${tr("Например, Анатомия")}"></div>
    <div class="field"><label>${tr("Цвет")}</label>${swatches(color)}</div>
    ${!s && sel.length ? `<label class="check"><input type="checkbox" id="sMove" checked> ${tr("Перенести в него выбранные")} ${files(sel.length)}</label>` : ""}
    ${s?.builtin ? `<p class="hint">${tr("Встроенный раздел: можно переименовать и перекрасить. Пустое название вернёт стандартное.")}</p>` : ""}
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="sOk">${s ? tr("Сохранить") : tr("Создать")}</button></div>`,
    (box, close) => {
      const pick = (c) => { color = c; $$("#sColors [data-c]", box).forEach((b) => b.classList.toggle("on", b.dataset.c === c)); };
      $$("#sColors [data-c]", box).forEach((b) => (b.onclick = () => pick(b.dataset.c)));
      $("#sCustom", box).oninput = (e) => pick(e.target.value);
      $("#sName", box).onkeydown = (e) => { if (e.key === "Enter") $("#sOk", box).click(); };
      $("#sOk", box).onclick = async () => {
        const name = $("#sName", box).value.trim();
        if (!name && !s?.builtin) return $("#sName", box).focus();
        let key;
        try {
          if (s) {
            const keepDefault = s.builtin && !s.name && name === KIND_PLURAL[s.key]; // не трогали стандартное имя
            await api(`/sections/${s.key}`, { method: "PATCH", body: { ...(keepDefault ? {} : { name }), color } });
            key = s.key;
          } else {
            key = (await api("/sections", { method: "POST", body: { name, color } })).key;
            if ($("#sMove", box)?.checked) await api("/media/bulk", { method: "POST", body: { ids: sel, kind: key } });
          }
        } catch { return; }
        close();
        if (!s) { toast(`${tr("Раздел создан")}: ${name}`); state.view = key; state.folder = 0; state.sub = ""; }
        await refresh();
        if (!s) { emit("navigate", "library"); load(); }
      };
    });
}

// ---------- удаление

async function deleteDialog(s) {
  s = (await api("/sections")).find((x) => x.key === s.key) || s; // свежее число файлов
  const others = SECTIONS.filter((x) => x.key !== s.key);
  modal(`<h2>${tr("Удалить раздел")} «${esc(KIND_PLURAL[s.key])}»?</h2>
    ${s.count ? `<p>${tr("В разделе")} ${files(s.count)}. ${tr("Что с ними сделать?")}</p>
      <label class="check"><input type="radio" name="dWhat" value="move" checked> ${tr("Перенести в раздел")}
        <select id="dTo">${others.map((x) => `<option value="${x.key}">${esc(KIND_PLURAL[x.key])}</option>`).join("")}</select></label>
      <label class="check"><input type="radio" name="dWhat" value="trash"> ${tr("Удалить файлы в Корзину")}</label>`
    : `<p>${tr("Раздел пуст.")}</p>`}
    <div class="actions"><button data-close id="dCancel">${tr("Отмена")}</button><button class="danger strong" id="dOk">${tr("Удалить раздел")}</button></div>`,
    (box, close) => {
      $("#dCancel", box).focus(); // опасное действие — по умолчанию «Отмена»
      $("#dOk", box).onclick = async () => {
        const trash = $('input[name="dWhat"]:checked', box)?.value === "trash";
        const to = $("#dTo", box)?.value || others[0].key;
        let r;
        try { r = await api(`/sections/${s.key}/delete`, { method: "POST", body: { move_to: to, trash } }); } catch { return; }
        close();
        toast(`${tr("Раздел удалён")}: ${KIND_PLURAL[s.key]}`);
        if (r.failed.length) {
          toast(`${tr("Не удалось удалить")}: ${r.failed.map((f) => f.name).join(", ")} — ${tr("они перенесены в раздел")} «${KIND_PLURAL[to]}»`, { life: 9000 });
        }
        if (state.view === s.key) state.view = "all";
        await Promise.all([refresh(), loadTags()]);
        load();
      };
    });
}
