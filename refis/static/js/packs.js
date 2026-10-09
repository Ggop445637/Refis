// Наборы референсов: подборка или доска одним файлом .refis — отправить другу, выложить в канал.
import { tr } from "./i18n.js";
import { $, api, esc, toast, modal, emit, fmtSize, files } from "./util.js";
import { state as lib, load, loadTags, loadFolders, folderDialog, toggleTag } from "./library.js";
import { openBoard } from "./boards.js";
import { settings } from "./settings.js";

const BIG = 300 * 1024 * 1024;
// как db.normalize_tag на сервере
const normTag = (t) => t.replace(/,/g, " ").trim().replace(/^#+/, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

// what: { ids?, boardId?, tag?, name }
export async function exportPackDialog(what) {
  const body = { ids: what.ids || [], board_id: what.boardId || null, tag: what.tag || "" };
  const est = await api("/packs/estimate", { method: "POST", body });
  if (!est.count) return toast(tr("В наборе нет файлов"), { error: true });
  modal(`<h2>📦 ${tr("Экспорт набора")}</h2>
    <p class="hint">${tr("Набор — один файл .refis с картинками, тегами и заметками. Его можно отправить другу или выложить в канал, а открыть — в Refis.")}${body.board_id ? " " + tr("Доска войдёт в набор целиком, с расположением и заметками.") : ""}</p>
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
  if (!lib.folders.length) {
    return toast(tr("Сначала добавьте папку библиотеки"), { action: tr("Добавить"), onAction: folderDialog });
  }
  const fd = new FormData();
  fd.append("file", file, file.name);
  toast(tr("Открываю набор…"), { life: 1500 });
  const info = await api("/packs/inspect", { method: "POST", body: fd });
  const refFolder = lib.folders.find((f) => f.kind === "ref") || lib.folders[0];
  const defTag = `${tr("набор")}/${info.name.toLowerCase()}`;
  modal(`<h2>📦 ${esc(info.name)}</h2>
    ${info.author || info.description ? `<p>${info.author ? `<b>${tr("Автор")}:</b> ${esc(info.author)}<br>` : ""}${esc(info.description).replace(/\n/g, "<br>")}</p>` : ""}
    ${info.preview.length ? `<div class="packprev">${info.preview.map((n) => `<img src="/api/packs/inbox/${info.token}/preview/${n}" alt="" loading="lazy">`).join("")}</div>` : ""}
    <p class="hint">${files(info.count)} · ${fmtSize(info.size)}${info.videos ? ` · ${tr("видео")}: ${info.videos}` : ""}${info.board ? ` · ${tr("с доской")}` : ""}</p>
    ${info.tags.length ? `<div class="row">${info.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="field"><label>${tr("Папка библиотеки")}</label>
      <select id="kFolder">${lib.folders.map((f) => `<option value="${f.id}"${f.id === refFolder.id ? " selected" : ""}>${esc(f.path)}</option>`).join("")}</select></div>
    <div class="field"><label>${tr("Подпапка")}</label><input type="text" id="kSub" value="${esc(info.name)}"></div>
    <div class="field"><label>${tr("Общий тег для всего набора")}</label><input type="text" id="kTag" value="${esc(defTag)}" placeholder="${tr("необязательно")}"></div>
    ${info.board ? `<label class="check"><input type="checkbox" id="kBoard" checked> ${tr("Создать доску из набора")}</label>` : ""}
    <p class="hint">${tr("Файлы, которые уже есть в библиотеке, второй раз не копируются — им только добавятся теги.")}</p>
    <div class="actions"><button data-close>${tr("Отмена")}</button><button class="primary" id="kOk">${tr("Добавить в библиотеку")}</button></div>`,
    (box, close) => {
      $("#kOk", box).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = tr("Добавляю…");
        const tag = $("#kTag", box).value.trim();
        let r;
        try {
          r = await api("/packs/import", { method: "POST", body: {
            token: info.token, folder_id: +$("#kFolder", box).value, subdir: $("#kSub", box).value, tag,
            board: !!$("#kBoard", box)?.checked } });
        } catch {
          btn.disabled = false;
          btn.textContent = tr("Добавить в библиотеку");
          return;
        }
        close();
        const msg = `${tr("Набор добавлен")}: ${files(r.added.length)}` + (r.existing.length ? ` (${tr("уже были")}: ${r.existing.length})` : "");
        toast(msg, r.board_id ? { action: tr("Открыть доску"), life: 9000, onAction: () => openBoard(r.board_id) } : { life: 6000 });
        await Promise.all([loadFolders(), loadTags()]);
        emit("navigate", "library");
        if (tag) { lib.tags = []; lib.ntags = []; toggleTag(normTag(tag)); } else load();
        emit("poll");
      };
    });
}
