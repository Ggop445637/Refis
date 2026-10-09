// Папки: дерево подпапок в боковой панели, свои новые папки и перемещение файлов между ними.
import { tr } from "./i18n.js";
import { $, $$, api, esc, store, toast, menu, modal, emit, files, KIND_PLURAL } from "./util.js";
import { state, load, loadFolders, loadTags, folderDialog, folderSettingsDialog, reloadKeepSelection } from "./library.js";
import { exportPackDialog } from "./packs.js";

export const DRAG_TYPE = "text/x-refis-ids";
const trees = {}; // id папки → [{ sub, name, depth, count }]
const open = new Set(store("openFolders") || []); // раскрытые узлы: "3" или "3:Руки/Мужские"
const key = (fid, sub) => (sub ? `${fid}:${sub}` : String(fid));
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const join = (...p) => p.filter(Boolean).join("/");

async function loadTree(fid) {
  trees[fid] = await api(`/folders/${fid}/tree`).catch(() => []);
  return trees[fid];
}
const loadAllTrees = () => Promise.all(state.folders.map((f) => loadTree(f.id)));

function saveOpen() { store("openFolders", [...open]); }

// refresh — заново спросить подпапки у раскрытых папок (после сканирования, перемещения)
export function renderFolders(refresh = false) {
  const need = state.folders.filter((f) => open.has(key(f.id)) && (refresh || !trees[f.id]));
  if (need.length) Promise.all(need.map((f) => loadTree(f.id))).then(() => renderFolders());
  const row = (f, d) => {
    const sub = d?.sub || "";
    const list = trees[f.id];
    const kids = list ? list.some((x) => x.sub.startsWith(sub ? sub + "/" : "")) : true;
    const isOpen = open.has(key(f.id, sub));
    const active = state.folder === f.id && state.sub === sub;
    return `<li data-id="${f.id}" data-sub="${esc(sub)}" class="${active ? "active" : ""}${d ? " subdir" : ""}"
        role="treeitem" tabindex="0" aria-level="${d ? d.depth + 2 : 1}" aria-selected="${active}" ${kids ? `aria-expanded="${isOpen}"` : ""}
        style="padding-left:${d ? 10 + (d.depth + 1) * 14 : 10}px" title="${esc(d ? join(base(f.path), sub) : f.path)}">
      <span class="caret${kids ? "" : " none"}" data-toggle aria-hidden="true">${isOpen ? "▾" : "▸"}</span>
      ${d ? "" : `<i class="dot k-${f.kind}"></i>`}<span class="name">${esc(d ? d.name : base(f.path))}</span>
      <span class="cnt">${d ? d.count || "" : f.count}</span></li>`;
  };
  const html = [];
  for (const f of state.folders) {
    html.push(row(f));
    if (!open.has(key(f.id)) || !trees[f.id]) continue;
    for (const d of trees[f.id]) {
      const parts = d.sub.split("/");
      // показываем, только если раскрыты все родители
      if (parts.slice(0, -1).every((_, i) => open.has(key(f.id, parts.slice(0, i + 1).join("/"))))) html.push(row(f, d));
    }
  }
  const had = document.activeElement?.closest?.("#folderlist li[data-id]");
  const focusKey = had && `${had.dataset.id}|${had.dataset.sub}`;
  $("#folderlist").innerHTML = html.join("") || `<li class="empty" role="none">${tr("Нажмите ＋, чтобы создать или добавить папку")}</li>`;
  if (focusKey) { // перерисовка не должна сбивать фокус с клавиатуры
    const li = $$("#folderlist li[data-id]").find((x) => `${x.dataset.id}|${x.dataset.sub}` === focusKey);
    if (li) li.focus({ preventScroll: true });
  }
}

const target = (li) => ({ f: state.folders.find((x) => x.id === +li.dataset.id), sub: li.dataset.sub || "" });

$("#folderlist").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const { f, sub } = target(li);
  if (e.target.closest("[data-toggle]")) {
    const k = key(f.id, sub);
    open.has(k) ? open.delete(k) : open.add(k);
    saveOpen();
    if (!trees[f.id]) await loadTree(f.id);
    return renderFolders();
  }
  const same = state.folder === f.id && state.sub === sub;
  state.folder = same ? 0 : f.id;
  state.sub = same ? "" : sub;
  renderFolders();
  emit("navigate", "library");
  load();
});

// дерево с клавиатуры, как в Проводнике: → раскрыть, ← свернуть
$("#folderlist").addEventListener("keydown", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
  const exp = li.getAttribute("aria-expanded");
  if ((e.key === "ArrowRight" && exp === "false") || (e.key === "ArrowLeft" && exp === "true")) {
    e.preventDefault(); e.stopPropagation();
    li.querySelector("[data-toggle]").click();
  }
});

$("#folderlist").addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  const { f, sub } = target(li);
  menu(e, [
    [`📁 ${tr("Новая подпапка…")}`, () => createFolderDialog({ fid: f.id, sub })],
    [`📦 ${tr("Экспорт набора…")}`, () => exportPackDialog({ folderId: f.id, sub, name: sub ? base(sub) : base(f.path) })],
    [tr("Показать в проводнике"), () => api(`/folders/${f.id}/reveal`, { method: "POST", body: { sub } })],
    ...(sub ? [] : ["-",
      [tr("Настройки папки…"), () => folderSettingsDialog(f)],
      [tr("Пересканировать"), async () => { await api(`/folders/${f.id}/scan`, { method: "POST" }); emit("poll"); }]]),
  ]);
});

$("#addFolder").onclick = (e) => menu(e, [
  [`📁 ${tr("Создать новую папку…")}`, () => createFolderDialog()],
  [`🔗 ${tr("Подключить существующую папку…")}`, () => folderDialog()],
]);

// ---------- перетаскивание карточек на папку

const dragIds = (e) => [...(e.dataTransfer?.types || [])].includes(DRAG_TYPE);
$("#folderlist").addEventListener("dragover", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || !dragIds(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  $$("#folderlist li.drop").forEach((x) => x !== li && x.classList.remove("drop"));
  li.classList.add("drop");
});
$("#folderlist").addEventListener("dragleave", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li && !li.contains(e.relatedTarget)) li.classList.remove("drop");
});
$("#folderlist").addEventListener("drop", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || !dragIds(e)) return;
  e.preventDefault();
  li.classList.remove("drop");
  const { f, sub } = target(li);
  moveTo(JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || "[]"), f.id, sub);
});

// ---------- перемещение

export async function moveTo(ids, fid, sub) {
  if (!ids.length) return;
  const f = state.folders.find((x) => x.id === fid);
  const r = await api("/media/move", { method: "POST", body: { ids, folder_id: fid, sub } });
  if (r.ids.length) toast(`${tr("Перемещено")}: ${files(r.ids.length)} → ${join(f ? base(f.path) : "", sub)}`);
  else if (!r.failed.length) toast(tr("Файлы уже в этой папке"));
  if (r.failed.length) {
    toast(`${tr("Не удалось переместить")}: ${r.failed.map((x) => x.name).join(", ")}. ${tr("Возможно, файл открыт в другой программе.")}`, { life: 8000 });
  }
  await Promise.all([loadFolders(), loadTags()]);
  renderFolders(true);
  await reloadKeepSelection();
}

export async function moveDialog(ids) {
  if (!state.folders.length) return createFolderDialog({ ids });
  await loadAllTrees();
  const rows = state.folders.flatMap((f) => [{ f, sub: "", label: base(f.path), depth: 0 },
    ...(trees[f.id] || []).map((d) => ({ f, sub: d.sub, label: d.name, depth: d.depth + 1 }))]);
  modal(`<h2>${tr("Переместить")} ${files(ids.length)}</h2>
    <p class="hint">${tr("Файлы переедут на диске в выбранную папку. Теги, оценки и заметки сохранятся.")}</p>
    <input type="text" id="mvFilter" placeholder="${tr("Найти папку…")}">
    <ul class="list movelist" id="mvList">${rows.map((r, i) => `<li data-i="${i}" style="padding-left:${10 + r.depth * 16}px" title="${esc(join(r.f.path, r.sub))}">
      ${r.depth ? "└" : `<i class="dot k-${r.f.kind}"></i>`} <span class="name">${esc(r.label)}</span></li>`).join("")}</ul>
    <div class="actions" style="justify-content:space-between"><button id="mvNew">📁 ${tr("Новая папка…")}</button>
      <button data-close>${tr("Отмена")}</button></div>`,
    (box, close) => {
      $("#mvFilter", box).oninput = (e) => {
        const q = e.target.value.trim().toLowerCase();
        $$("#mvList li", box).forEach((li) => {
          const r = rows[+li.dataset.i];
          li.hidden = !!q && !join(base(r.f.path), r.sub).toLowerCase().includes(q);
        });
      };
      $("#mvList", box).onclick = (e) => {
        const li = e.target.closest("li[data-i]");
        if (!li) return;
        const r = rows[+li.dataset.i];
        close();
        moveTo(ids, r.f.id, r.sub);
      };
      $("#mvNew", box).onclick = () => { close(); setTimeout(() => createFolderDialog({ ids }), 200); };
    });
}

// ---------- новая папка

// fid/sub — создать внутри этой папки; ids — сразу переместить туда эти файлы
export async function createFolderDialog({ fid = 0, sub = "", ids = [] } = {}) {
  await loadAllTrees();
  const def = fid ? `${fid}|${sub}` : state.folder ? `${state.folder}|${state.sub}` : "new";
  const where = [`<option value="new">${tr("Отдельная папка библиотеки")}</option>`,
    ...state.folders.flatMap((f) => [
      `<option value="${f.id}|">${tr("Внутри")}: ${esc(base(f.path))}</option>`,
      ...(trees[f.id] || []).map((d) => `<option value="${f.id}|${esc(d.sub)}">${tr("Внутри")}: ${esc(join(base(f.path), d.sub))}</option>`),
    ])];
  const native = !!window.pywebview?.api?.pick_folder;
  modal(`<h2>📁 ${tr("Новая папка")}</h2>
    <p class="hint">${tr("Папка появится на диске. Кладите в неё файлы: перетащите карточки на папку в боковой панели или выберите «Переместить в папку…».")}</p>
    <div class="field"><label>${tr("Название")}</label><input type="text" id="nName" placeholder="${tr("Например, Руки")}"></div>
    <div class="field"><label>${tr("Где создать")}</label><select id="nWhere">${where.join("")}</select></div>
    <div id="nNew">
      <div class="field"><label>${tr("Расположение на диске")}</label>
        <div class="row" style="flex-wrap:nowrap"><input type="text" id="nParent">${native ? `<button id="nPick">${tr("Обзор…")}</button>` : ""}</div></div>
      <div class="field"><label>${tr("Раздел для её файлов")}</label>
        <select id="nKind">${Object.entries(KIND_PLURAL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    </div>
    <div class="actions"><button data-close>${tr("Отмена")}</button>
      <button class="primary" id="nOk">${ids.length ? `${tr("Создать и переместить")} ${files(ids.length)}` : tr("Создать")}</button></div>`,
    (box, close) => {
      const sel = $("#nWhere", box);
      sel.value = [...sel.options].some((o) => o.value === def) ? def : "new";
      const sync = () => ($("#nNew", box).hidden = sel.value !== "new");
      sel.onchange = sync;
      sync();
      api("/folders/default-parent").then((r) => { if (!$("#nParent", box).value) $("#nParent", box).value = r.path; }).catch(() => {});
      if (native) $("#nPick", box).onclick = async () => {
        const p = await window.pywebview.api.pick_folder();
        if (p) $("#nParent", box).value = p;
      };
      $("#nName", box).onkeydown = (e) => { if (e.key === "Enter") $("#nOk", box).click(); };
      $("#nOk", box).onclick = async (e) => {
        const name = $("#nName", box).value.trim();
        if (!name) return $("#nName", box).focus();
        const btn = e.currentTarget;
        btn.disabled = true;
        let to;
        try {
          if (sel.value === "new") {
            const r = await api("/folders/create", { method: "POST", body: { parent: $("#nParent", box).value, name, kind: $("#nKind", box).value } });
            to = { fid: r.id, sub: "" };
          } else {
            const [f, s] = [+sel.value.split("|")[0], sel.value.slice(sel.value.indexOf("|") + 1)];
            const r = await api(`/folders/${f}/mkdir`, { method: "POST", body: { sub: join(s, name) } });
            to = { fid: f, sub: r.sub };
            // раскрываем путь до новой папки, чтобы её было видно
            const parts = r.sub.split("/");
            open.add(key(f));
            parts.slice(0, -1).forEach((_, i) => open.add(key(f, parts.slice(0, i + 1).join("/"))));
            saveOpen();
          }
        } catch {
          btn.disabled = false;
          return;
        }
        close();
        toast(`📁 ${tr("Папка создана")}: ${name}`);
        if (ids.length) await moveTo(ids, to.fid, to.sub);
        await loadFolders();
        renderFolders(true);
        state.folder = to.fid;
        state.sub = to.sub;
        emit("navigate", "library");
        load();
        if (!ids.length) emit("poll");
      };
    });
}
