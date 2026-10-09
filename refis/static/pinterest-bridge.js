// Встраивается в окно pinterest.com внутри Refis (не в сам интерфейс Refis).
// Добавляет на пины кнопку «＋ Refis» и передаёт в Refis пины из домашней ленты (рекомендации).
(() => {
  if (window.__refisBridge) return;
  window.__refisBridge = true;

  const api = () => window.pywebview && window.pywebview.api;
  const seen = new Set();
  let queue = [];
  let collected = 0;

  const style = document.createElement("style");
  style.textContent = `
    .refis-save { position: absolute; top: 10px; left: 10px; z-index: 50; padding: 7px 12px; border: 0; border-radius: 999px;
      font: 600 13px/1 "Segoe UI", system-ui, sans-serif; color: #1b0f08; cursor: pointer; opacity: 0; transform: translateY(-4px);
      background: linear-gradient(135deg, #ffc371, #ff6b6b 55%, #7c5cff); box-shadow: 0 6px 18px -6px rgba(0,0,0,.5);
      transition: opacity .18s, transform .18s; }
    .refis-host:hover .refis-save, .refis-save.done, .refis-save.busy { opacity: 1; transform: none; }
    .refis-save.done { background: #2b2b33; color: #fff; }
    .refis-toast { position: fixed; right: 16px; bottom: 16px; z-index: 99999; padding: 10px 14px; border-radius: 12px;
      font: 13px/1.35 "Segoe UI", system-ui, sans-serif; color: #ececf1; background: rgba(22,22,30,.94); box-shadow: 0 10px 30px rgba(0,0,0,.4);
      opacity: 0; transform: translateY(8px); transition: opacity .25s, transform .25s; pointer-events: none; max-width: 320px; }
    .refis-toast.show { opacity: 1; transform: none; }`;
  document.documentElement.appendChild(style);

  const toastEl = document.createElement("div");
  toastEl.className = "refis-toast";
  let toastTimer;
  function toast(text) {
    if (!toastEl.isConnected) document.body.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  const pinId = (a) => ((a.getAttribute("href") || "").match(/\/pin\/(\d{5,25})/) || [])[1];
  function bestSrc(img) {
    const set = img.getAttribute("srcset");
    if (set) {
      const parts = set.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return img.currentSrc || img.src;
  }
  const onHomeFeed = () => location.pathname === "/" || location.pathname.startsWith("/homefeed") || location.pathname.startsWith("/today");

  function pinData(id, img) {
    return { id, image: bestSrc(img), title: (img.getAttribute("alt") || "").slice(0, 200) };
  }

  function addButton(host, id, img) {
    host.classList.add("refis-host");
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const b = document.createElement("button");
    b.className = "refis-save";
    b.type = "button";
    b.textContent = "＋ Refis";
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!api() || b.classList.contains("busy")) return;
      b.classList.add("busy");
      b.textContent = "…";
      try {
        const r = await api().save(pinData(id, img));
        b.classList.toggle("done", !!r.ok);
        b.textContent = r.ok ? "✓ В Refis" : "⚠ Ошибка";
        toast(r.ok ? (r.already ? "Этот пин уже в библиотеке Refis" : "Сохранено в библиотеку Refis") : (r.error || "Не удалось сохранить"));
      } catch (err) {
        b.textContent = "⚠ Ошибка";
      } finally {
        b.classList.remove("busy");
      }
    }, true);
    host.appendChild(b);
  }

  function scan() {
    document.querySelectorAll('a[href*="/pin/"]').forEach((a) => {
      const id = pinId(a);
      if (!id) return;
      const img = a.querySelector('img[src*="pinimg.com"]');
      if (!img) return;
      const host = a.closest('[data-test-id="pin"], [data-test-id="pinWrapper"], [data-grid-item="true"]') || a.parentElement || a;
      if (!host.querySelector(":scope > .refis-save")) addButton(host, id, img);
      if (!seen.has(id) && onHomeFeed()) {
        seen.add(id);
        queue.push(pinData(id, img));
      }
    });
  }

  async function flush() {
    if (!queue.length || !api() || !api().collect) return;
    const batch = queue.splice(0, 100);
    try {
      const n = await api().collect(batch);
      if (n) {
        collected += n;
        toast(`Refis: +${n} в «Рекомендации» (всего ${collected})`);
      }
    } catch (e) {
      queue = batch.concat(queue);
    }
  }

  scan();
  new MutationObserver(() => { clearTimeout(window.__refisScan); window.__refisScan = setTimeout(scan, 300); })
    .observe(document.documentElement, { childList: true, subtree: true });
  setInterval(flush, 2000);
})();
