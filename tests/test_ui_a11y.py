"""Доступность и нормы дизайна: WCAG 2.2 AA (axe-core + контраст по пикселям), размеры, клавиатура, окна.

Идёт после остальных UI-тестов — библиотека уже наполнена, страницы показывают настоящие данные.
"""
import pytest

pytest.importorskip("playwright.sync_api")

from a11y_tools import axe, measure, pixel_contrast  # noqa: E402

PAGES = ["today", "organize", "library", "boards", "pinterest", "profile", "settings"]
GRAD = {"dark": [[255, 195, 113, 1], [255, 107, 107, 1], [164, 141, 255, 1]],
        "light": [[154, 82, 8, 1], [173, 49, 49, 1], [91, 58, 214, 1]]}


def set_theme(page, client, theme):
    client.patch("/api/settings", json={"theme": theme})
    page.reload()
    page.wait_for_timeout(1200)


def close_overlays(page):
    for _ in range(3):
        if page.is_visible("#modal") or page.is_visible("#viewer") or page.is_visible("#ctxmenu"):
            page.keyboard.press("Escape")
            page.wait_for_timeout(250)


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_pages_meet_wcag(page, client, theme):
    close_overlays(page)
    set_theme(page, client, theme)
    problems = []
    for name in PAGES:
        page.click(f"#mainNav [data-page={name}], [data-page={name}]")
        page.wait_for_timeout(1100)
        problems += [f"{theme}/{name} axe: {v}" for v in axe(page)]
        problems += [f"{theme}/{name} контраст {r} < {need}: {d}" for r, need, d in pixel_contrast(page, GRAD[theme])]
        m = measure(page)
        problems += [f"{theme}/{name} мелкая цель: {x}" for x in m["small"]]
        problems += [f"{theme}/{name} мелкий текст: {x}" for x in m["tiny"]]
    assert not problems, "\n".join(problems)
    assert not page.errors, page.errors


def test_details_viewer_and_dialogs_meet_wcag(page, client):
    set_theme(page, client, "dark")
    page.click("#mainNav [data-page=library]")
    page.wait_for_timeout(800)
    page.locator(".card").first.click()
    page.wait_for_timeout(600)
    problems = [f"детали: {v}" for v in axe(page)]
    page.locator(".card").first.dblclick()
    page.wait_for_timeout(900)
    problems += [f"просмотр: {v}" for v in axe(page)]
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    page.click("#addFolder")
    page.click("#ctxmenu button >> nth=0")
    page.wait_for_selector("#nName")
    problems += [f"окно: {v}" for v in axe(page)]
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    assert not problems, "\n".join(problems)


def test_dialog_traps_focus_and_returns_it(page):
    close_overlays(page)
    page.click("#mainNav [data-page=library]")
    page.focus("#saveSearch")
    page.keyboard.press("Enter")
    page.wait_for_selector("#mVal")
    assert page.get_attribute("#modal .mbox", "role") == "dialog"
    assert page.get_attribute("#modal .mbox", "aria-modal") == "true"
    title = page.get_attribute("#modal .mbox", "aria-labelledby")
    assert title and page.inner_text(f"#{title}")
    for _ in range(6):  # Tab ходит по кругу внутри окна
        page.keyboard.press("Tab")
        assert page.evaluate("() => document.querySelector('#modal .mbox').contains(document.activeElement)")
    page.keyboard.press("Shift+Tab")
    assert page.evaluate("() => document.querySelector('#modal .mbox').contains(document.activeElement)")
    page.keyboard.press("Escape")
    page.wait_for_function("document.activeElement?.id === 'saveSearch'", timeout=3000)
    page.wait_for_selector("#modal", state="hidden", timeout=3000)
    assert page.evaluate("() => document.activeElement.id") == "saveSearch"  # и после анимации закрытия


def test_enter_in_prompt_does_not_reopen_dialog(page):
    page.focus("#saveSearch")
    page.keyboard.press("Enter")
    page.wait_for_selector("#mVal")
    page.fill("#mVal", "Поиск для теста клавиатуры")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    assert not page.is_visible("#modal")


def test_destructive_confirm_defaults_to_cancel(page):
    close_overlays(page)
    page.click("#mainNav [data-page=library]")
    page.wait_for_timeout(500)
    page.locator(".card").first.click()
    page.keyboard.press("Delete")
    page.wait_for_selector("#mOk")
    assert page.evaluate("() => document.activeElement.id") == "mCancel"
    assert "danger" in page.get_attribute("#mOk", "class")
    page.keyboard.press("Enter")  # Enter на «Отмене» — ничего не удалено
    page.wait_for_timeout(400)
    assert not page.is_visible("#modal") and page.locator(".card").count() > 0


def test_grid_and_menu_by_keyboard(page):
    close_overlays(page)
    page.click("#mainNav [data-page=library]")
    page.wait_for_timeout(500)
    page.keyboard.press("Escape")  # снять выделение
    page.focus("#grid")
    assert page.get_attribute("#grid", "role") == "listbox"
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(300)
    active = page.get_attribute("#grid", "aria-activedescendant")
    assert active and page.get_attribute(f"#{active}", "aria-selected") == "true"
    assert page.get_attribute(f"#{active}", "aria-label")
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(200)
    assert page.get_attribute("#grid", "aria-activedescendant") != active
    page.keyboard.press("Shift+F10")
    page.wait_for_timeout(250)
    assert page.is_visible("#ctxmenu")
    assert page.evaluate("() => document.activeElement.getAttribute('role')") == "menuitem"
    page.keyboard.press("ArrowDown")
    assert page.evaluate("() => document.activeElement.getAttribute('role')") == "menuitem"
    page.keyboard.press("Escape")
    page.wait_for_timeout(100)
    assert not page.is_visible("#ctxmenu")
    assert page.evaluate("() => document.activeElement.id") == "grid"
    size = int(page.input_value("#thumbSize"))
    page.keyboard.press("Control+=")
    assert int(page.input_value("#thumbSize")) == size + 40
    page.keyboard.press("Control+0")
    assert int(page.input_value("#thumbSize")) == 220


def test_sidebar_lists_work_by_keyboard(page):
    close_overlays(page)
    page.click("#mainNav [data-page=library]")
    page.wait_for_timeout(400)
    tag = page.locator("#taglist li[role=option]").first
    name = tag.get_attribute("data-tag")
    tag.focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(600)
    assert page.locator(f'#taglist li[data-tag="{name}"]').get_attribute("aria-selected") == "true"
    page.locator(f'#taglist li[data-tag="{name}"]').focus()
    page.keyboard.press("Enter")  # снять фильтр
    page.wait_for_timeout(600)
    folder = page.locator("#folderlist li[role=treeitem]").first
    folder.focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(600)
    assert page.locator("#folderlist li[role=treeitem]").first.get_attribute("aria-selected") == "true"
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)


def test_viewer_background_and_focus_return(page):
    close_overlays(page)
    page.click("#mainNav [data-page=library]")
    page.wait_for_timeout(400)
    page.focus("#grid")
    page.keyboard.press("ArrowRight")
    page.keyboard.press("Enter")
    page.wait_for_timeout(700)
    assert page.is_visible("#viewer") and page.get_attribute("#viewer", "role") == "dialog"
    page.keyboard.press("n")
    assert "bg-gray" in page.get_attribute("#viewer", "class")
    page.keyboard.press("n")
    assert "bg-light" in page.get_attribute("#viewer", "class")
    page.keyboard.press("n")
    assert "bg-" not in page.get_attribute("#viewer", "class")
    page.keyboard.press("Tab")
    assert page.evaluate("() => document.querySelector('#viewer').contains(document.activeElement)")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    assert page.evaluate("() => document.activeElement.id") == "grid"
    assert not page.errors, page.errors


def test_reduced_motion_is_respected(page):
    ctx = page.context.browser.new_context(reduced_motion="reduce", viewport={"width": 1200, "height": 800})
    p = ctx.new_page()
    p.goto(page.base + "/")
    p.wait_for_timeout(1000)
    p.click("[data-page=library]")
    p.wait_for_timeout(200)
    long = p.evaluate("""() => document.getAnimations().map((a) => a.effect?.getTiming?.().duration)
      .filter((d) => typeof d === 'number' && d > 1)""")
    ctx.close()
    assert long == [], long
