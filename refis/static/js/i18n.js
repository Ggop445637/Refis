// Перевод интерфейса. Ключи — русские строки, словари — в js/lang/*.js.
// Язык известен уже при загрузке модулей (из localStorage), поэтому даже константы
// вида { ref: t("Референс") } сразу получают нужный язык. Смена языка перезагружает окно.
import EN from "./lang/en.js";

const DICTS = { en: EN };

function initialLang() {
  try { return localStorage.getItem("refis.lang") || "ru"; } catch { return "ru"; }
}

export let lang = initialLang();
document.documentElement.lang = lang;

/** Запоминает язык для следующей загрузки. Возвращает true, если нужна перезагрузка. */
export function rememberLang(l) {
  try { localStorage.setItem("refis.lang", l); } catch {}
  return l !== lang;
}

const fill = (s, vals) => s.replace(/\{(\d+)\}/g, (_, i) => (vals[+i] ?? ""));

/**
 * t("Строка") или t`Строка с ${значением}` (ключ — «Строка с {0}»).
 * Без перевода возвращает русский текст — интерфейс никогда не ломается.
 */
export function t(strings, ...vals) {
  const key = typeof strings === "string" ? strings : strings.slice(1).reduce((acc, part, i) => `${acc}{${i}}${part}`, strings[0]);
  const dict = DICTS[lang];
  const out = (dict && dict[key]) ?? key;
  return vals.length ? fill(out, vals) : out;
}

/** Множественное число: plural(n, "файл", "файла", "файлов"). В английском словаре — "файл|файла|файлов": ["file", "files"]. */
export function plural(n, one, few, many) {
  const dict = DICTS[lang];
  if (dict) {
    const forms = dict[`${one}|${few}|${many}`];
    if (forms) return Math.abs(n) === 1 ? forms[0] : forms[1];
  }
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Локаль для дат и чисел. */
export const loc = () => (lang === "en" ? "en-US" : "ru-RU");

/** Перевод неизменяемой разметки index.html: текст, placeholder и title. */
export function translateStatic(root = document.body) {
  if (lang === "ru") return;
  const dict = DICTS[lang];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((n) => {
    const raw = n.nodeValue, key = raw.trim();
    if (key && dict[key]) n.nodeValue = raw.replace(key, dict[key]);
  });
  root.querySelectorAll("[placeholder], [title]").forEach((el) => {
    for (const a of ["placeholder", "title"]) {
      const v = el.getAttribute(a);
      if (v && dict[v]) el.setAttribute(a, dict[v]);
    }
  });
}
export const tr = t;
