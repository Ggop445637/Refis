// Доступность без ручной разметки в каждом окне: подписи полей, списки с клавиатуры, alt у картинок.
// Работает на всё, что появляется в интерфейсе (окна, панели, страницы), через MutationObserver.
import { openContextMenuFor } from "./util.js";
import { tr } from "./i18n.js";

let seq = 0;
const uid = (p) => `${p}${++seq}`;
const CONTROL = "input:not([type=hidden]), select, textarea";

function named(el) {
  if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return true;
  if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
  return !!el.closest("label");
}

function fix(root) {
  // «.field > label» + поле рядом: связываем, чтобы диктор читал подпись, а клик по ней ставил фокус
  root.querySelectorAll?.(".field > label:not([for])").forEach((label) => {
    const ctl = label.parentElement.querySelector(CONTROL);
    if (!ctl || ctl.closest("label")) return;
    if (!ctl.id) ctl.id = uid("f");
    label.htmlFor = ctl.id;
  });
  // строки настроек: «название — переключатель»
  root.querySelectorAll?.(".set-row").forEach((row) => {
    const b = row.querySelector(".lbl b");
    if (!b) return;
    if (!b.id) b.id = uid("l");
    row.querySelectorAll(CONTROL).forEach((c) => { if (!named(c) || c.closest("label.switch")) c.setAttribute("aria-labelledby", b.id); });
    row.querySelectorAll(".seg").forEach((s) => { s.setAttribute("role", "group"); s.setAttribute("aria-labelledby", b.id); });
  });
  // поле с одной всплывающей подсказкой — подсказка становится названием
  root.querySelectorAll?.(`${CONTROL}`).forEach((c) => {
    if (named(c)) return;
    const name = c.getAttribute("title") || c.getAttribute("placeholder");
    if (name) c.setAttribute("aria-label", name);
  });
  // кнопки-значки без текста
  root.querySelectorAll?.("button").forEach((b) => {
    if (!b.getAttribute("aria-label") && !b.textContent.trim() && b.title) b.setAttribute("aria-label", b.title);
  });
  // списки в боковой панели и окнах — «список выбора»: Tab до пункта, стрелки по пунктам, выбранное отмечено
  const lists = root.matches?.(".list") ? [root] : [];
  root.querySelectorAll?.(".list").forEach((l) => lists.push(l));
  for (const ul of lists) {
    if (ul.getAttribute("role") === "tree") continue; // дерево папок размечает folders.js
    if (!ul.querySelector(":scope > li:not(.empty)")) { ul.removeAttribute("role"); continue; } // пустой — просто текст
    ul.setAttribute("role", "listbox");
    if (!ul.getAttribute("aria-label") && !ul.getAttribute("aria-labelledby")) {
      const h = ul.closest(".sb-section")?.querySelector("h3") || ul.closest(".field")?.querySelector("label");
      if (h) { if (!h.id) h.id = uid("h"); ul.setAttribute("aria-labelledby", h.id); }
    }
    ul.querySelectorAll(":scope > li").forEach((li) => {
      if (li.classList.contains("empty")) { li.setAttribute("role", "presentation"); return; }
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", li.matches(".active, .inc") ? "true" : "false");
      if (!li.hasAttribute("tabindex")) li.tabIndex = 0;
    });
  }
  // превью-плитки (лента «Сегодня», Pinterest, доски) открываются кликом — значит, и с клавиатуры
  root.querySelectorAll?.(".thumb[data-id], .bcard").forEach((t) => {
    if (t.hasAttribute("tabindex")) return;
    t.tabIndex = 0;
    t.setAttribute("role", "button");
    if (!t.getAttribute("aria-label")) t.setAttribute("aria-label", t.title || t.querySelector("b")?.textContent || t.textContent.trim() || t.querySelector("img")?.alt || tr("Открыть"));
  });
  root.querySelectorAll?.("img:not([alt])").forEach((img) => img.setAttribute("alt", ""));
  root.querySelectorAll?.(".seg button, #mainNav button, #views button").forEach(syncState);
}

// состояние кнопок: сегменты «Всё / Фото / Видео» — нажата или нет, навигация — текущая страница
function syncState(b) {
  if (b.closest(".seg")) b.setAttribute("aria-pressed", b.classList.contains("on") ? "true" : "false");
  else if (b.closest("#mainNav, #views")) {
    if (b.classList.contains("active")) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
}
new MutationObserver((muts) => {
  for (const m of muts) if (m.target.matches?.(".seg button, #mainNav button, #views button")) syncState(m.target);
}).observe(document.body, { attributes: true, attributeFilter: ["class"], subtree: true });

let pending = new Set(), scheduled = false;
const flush = () => { scheduled = false; const list = pending; pending = new Set(); list.forEach((n) => n.isConnected && fix(n)); };
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) pending.add(n.parentElement || n);
  if (pending.size && !scheduled) { scheduled = true; queueMicrotask(flush); } // до отрисовки — диктор сразу видит подписи
}).observe(document.body, { childList: true, subtree: true });
fix(document.body);

// Enter/Пробел нажимают «кнопку»-пункт списка, стрелки ходят по списку, Shift+F10 — меню
addEventListener("keydown", (e) => {
  const li = e.target.closest?.('.list li[role="option"], .list li[role="treeitem"], .thumb[role="button"], .bcard[role="button"]');
  if (li) {
    if (e.key === "Enter" || e.key === " ") {
      if (e.target !== li) return; // кнопка внутри пункта (стрелка папки) сама обработает
      e.preventDefault(); e.stopPropagation();
      li.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }));
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && li.tagName === "LI") {
      const items = [...li.parentElement.querySelectorAll(':scope > li[tabindex]')].filter((x) => !x.hidden);
      const i = items.indexOf(li) + (e.key === "ArrowDown" ? 1 : -1);
      if (items[i]) { e.preventDefault(); e.stopPropagation(); items[i].focus(); }
      return;
    }
  }
  if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && document.activeElement && document.activeElement !== document.body) {
    const el = document.activeElement.closest('li[tabindex], [data-section], .bcard, button') || document.activeElement;
    if (el.closest("#grid, #gridwrap")) return; // у сетки своё меню — по выбранным карточкам
    e.preventDefault();
    openContextMenuFor(el);
  }
}, true);
