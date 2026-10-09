// Наборы референсов: подборка или доска одним файлом .refis — отправить другу, выложить в канал.
import { tr } from "./i18n.js";
import { $, api, esc, toast, modal, emit, fmtSize, files, KIND_PLURAL } from "./util.js";
import { state as lib, load, loadTags, loadFolders, toggleTag } from "./library.js";
import { openBoard } from "./boards.js";
import { loadSections } from "./sections.js";
import { settings } from "./settings.js";

const BIG = 300 * 1024 * 1024;
// как db.normalize_tag на сервере
const normTag = (t) => t.replace(/,/g, " ").trim().replace(/^#+/, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

// what: { ids?, boardId?, tag?, folderId?, sub?, kind?, name }
export async function exportPackDialog(what) {
  const body = { ids: what.ids || [], board_id: what.boardId || null, tag: what.tag || "", folder_id: what.folderId || null,
    sub: what.sub || "", kind: what.kind || "" };
  const est = await api("/packs/estimate", { method: "POST", body });
  if (!est.count) return toast(tr("В наборе нет файлов"), { error: true });
  modal(`<h2>📦 ${tr("Экспорт набора")}</h2>
    <p class="hint">${tr("Набор — один файл .refis с картинками, тегами и заметками. Его можно отправить другу или выложить в канал, а открыть — в Refis.")}${body.board_id ? " " + tr("Доска войдёт в набор целиком, с расположением и заметками.") : ""}${body.folder_id ? " " + tr("Папка войдёт целиком, со всеми подпапками — так её можно перенести на другой компьютер или отдать другу.") : ""}${body.kind ? " " + tr("Раздел войдёт целиком: все его файлы с папками, тегами, названием и цветом раздела. При открытии раздел появится в библиотеке.") : ""}</p>
    <div class="field"><label>${tr("Название")}</label><input type="text" id="kName" value="${esc(what.name || "")}"></div>
    <div class="field"><label>${tr("Автор")}</label><input type="text" id="kAuthor" value="${esc(settings.name || "")}" placeholder="${tr("необязательно")}"></div>
    <div class="field"><label>${tr("Описание")}</label><textarea id="kDesc" placeholder="${tr("Что внутри и как этим пользоваться")}"></textarea></div>
    <label class="check"><input type="checkbox" id="kNotes" checked> ${tr("Включить мои заметки к файлам")}</label>
    <p class="hint">${files(est.count)} · ${fmtSize(est.size)}${est.videos ? ` · ${tr("видео")}: ${est.videos}` : ""}
      ${est.size > BIG ? `<br>⚠ ${tr("Набор получится большим — видео занимают много места.")}` : ""}</p>
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="kOk">${tr("Сохранить набор")}</button></div>`,
    (box, close) => {
      $("#kName", box).onkeydown = (e) => { if (e.key === "Enter") $("#kOk", box).click(); };
      $("#kOk", box).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = tr("Собираю…");
        try {
          const r = await api("/packs/export", { method: "POST", body: {
            ...body, name: $("#kName", box).value.trim() || tr("Набор"), author: $("#kAuthor", box).value,
            description: $("#kDesc", box).value, notes: $("#kNotes", box).checked } });
          close();
          toast(`${tr("Набор сохранён")}: ${r.path}`, { action: tr("Показать"), life: 9000,
            onAction: () => api("/packs/reveal", { method: "POST", body: { path: r.path } }) });
          api("/packs/reveal", { method: "POST", body: { path: r.path } }).catch(() => {});
        } catch {
          btn.disabled = false;
          btn.textContent = tr("Сохранить набор");
        }
      };
    });
}

export function openPackFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".refis,.zip";
  input.onchange = () => input.files[0] && importPack(input.files[0]);
  input.click();
}

export const isPackFile = (f) => /\.refis$/i.test(f.name);

export async function importPack(file) {
  if (!lib.folders.length) await loadFolders();
  const fd = new FormData();
  fd.append("file", file, file.name);
  toast(tr("Открываю набор…"), { life: 1500 });
  const info = await api("/packs/inspect", { method: "POST", body: fd });
  const isFolder = !!info.folder || !!info.section;
  // целую папку по умолчанию кладём отдельной папкой библиотеки, подборку — в папку с референсами
  const refFolder = lib.folders.find((f) => f.kind === "ref") || lib.folders[0];
  const defWhere = isFolder || !refFolder ? "new" : String(refFolder.id);
  const defTag = isFolder ? "" : `${tr("набор")}/${info.name.toLowerCase()}`;
  const fromPack = info.section || (info.folder && !info.folder.kind); // раздел, которого здесь может не быть
  const packSection = info.section ? info.section.name : "";
  const native = !!window.pywebview?.api?.pick_folder;
  modal(`<h2>📦 ${esc(info.name)}</h2>
    ${info.author || info.description ? `<p>${info.author ? `<b>${tr("Автор")}:</b> ${esc(info.author)}<br>` : ""}${esc(info.description).replace(/\n/g, "<br>")}</p>` : ""}
    ${info.preview.length ? `<div class="packprev">${info.preview.map((n) => `<img src="/api/packs/inbox/${info.token}/preview/${n}" alt="" loading="lazy">`).join("")}</div>` : ""}
    <p class="hint">${info.section ? `<i class="dot" style="background:${esc(info.section.color || "#888")}"></i> ${tr("Раздел")} «${esc(info.section.name)}» · `
      : info.folder ? `📁 ${tr("Папка")} «${esc(info.folder.name)}» · ` : ""}${files(info.count)} · ${fmtSize(info.size)}${info.dirs ? ` · ${tr("подпапок")}: ${info.dirs}` : ""}${info.videos ? ` · ${tr("видео")}: ${info.videos}` : ""}${info.board ? ` · ${tr("с доской")}` : ""}</p>
    ${info.tags.length ? `<div class="row">${info.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="field"><label>${tr("Куда добавить")}</label>
      <select id="kFolder"><option value="new">＋ ${tr("Новая папка библиотеки")}</option>
        ${lib.folders.map((f) => `<option value="${f.id}"${String(f.id) === defWhere ? " selected" : ""}>${esc(f.path)}</option>`).join("")}</select></div>
    <div id="kNewBox">
      <div class="field"><label>${tr("Название папки")}</label><input type="text" id="kNewName" value="${esc(info.folder?.name || packSection || info.name)}"></div>
      <div class="field"><label>${tr("Расположение на диске")}</label>
        <div class="row" style="flex-wrap:nowrap"><input type="text" id="kParent">${native ? `<button id="kPick">${tr("Обзор…")}</button>` : ""}</div></div>
      <div class="field"><label>${tr("Раздел для её файлов")}</label>
        <select id="kKind">${fromPack ? `<option value="" selected>${packSection ? `${tr("Раздел из набора")}: ${esc(packSection)}` : tr("Как в наборе")}</option>` : ""}
          ${Object.entries(KIND_PLURAL).map(([k, v]) => `<option value="${k}"${!fromPack && k === (info.folder?.kind || "ref") ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
    </div>
    <div class="field" id="kSubBox"><label>${tr("Подпапка")}</label><input type="text" id="kSub" value="${esc(info.folder?.name || packSection || info.name)}"></div>
    <div class="field"><label>${tr("Общий тег для всего набора")}</label><input type="text" id="kTag" value="${esc(defTag)}" placeholder="${tr("необязательно")}"></div>
    ${info.own ? `<label class="check"><input type="checkbox" id="kOwnRef"${isFolder ? "" : " checked"}> ${tr("Сделать «Мои работы» из набора референсами")}<br><small class="muted">${tr("Снимите, если переносите собственную папку на другой компьютер")}</small></label>` : ""}
    ${info.board ? `<label class="check"><input type="checkbox" id="kBoard" checked> ${tr("Создать доску из набора")}</label>` : ""}
    <p class="hint">${tr("Файлы, которые уже есть в библиотеке, второй раз не копируются — им только добавятся теги.")}</p>
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="kOk">${tr("Добавить в библиотеку")}</button></div>`,
    (box, close) => {
      const sel = $("#kFolder", box);
      sel.value = defWhere;
      const sync = () => { $("#kNewBox", box).hidden = sel.value !== "new"; $("#kSubBox", box).hidden = sel.value === "new"; };
      sel.onchange = sync;
      sync();
      api("/folders/default-parent").then((r) => { if (!$("#kParent", box).value) $("#kParent", box).value = r.path; }).catch(() => {});
      if (native) $("#kPick", box).onclick = async () => {
        const p = await window.pywebview.api.pick_folder();
        if (p) $("#kParent", box).value = p;
      };
      $("#kOk", box).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = tr("Добавляю…");
        const tag = $("#kTag", box).value.trim();
        const into = sel.value === "new"
          ? { new_parent: $("#kParent", box).value, new_name: $("#kNewName", box).value.trim(), new_kind: $("#kKind", box).value }
          : { folder_id: +sel.value, subdir: $("#kSub", box).value };
        let r;
        try {
          r = await api("/packs/import", { method: "POST", body: {
            token: info.token, ...into, tag, board: !!$("#kBoard", box)?.checked, own_as_ref: $("#kOwnRef", box)?.checked ?? true } });
        } catch {
          btn.disabled = false;
          btn.textContent = tr("Добавить в библиотеку");
          return;
        }
        close();
        const msg = `${tr("Набор добавлен")}: ${files(r.added.length)}` + (r.existing.length ? ` (${tr("уже были")}: ${r.existing.length})` : "");
        toast(msg, r.board_id ? { action: tr("Открыть доску"), life: 9000, onAction: () => openBoard(r.board_id) } : { life: 6000 });
        await Promise.all([loadFolders(), loadTags(), loadSections()]);
        emit("navigate", "library");
        if (tag) { lib.tags = []; lib.ntags = []; lib.folder = 0; lib.sub = ""; toggleTag(normTag(tag)); }
        else { lib.folder = r.folder_id; lib.sub = ""; load(); }
        emit("poll");
      };
    });
}
