/**
 * tabyo reader.js — all reader-facing behaviour (stage 3), vanilla JS:
 *
 * - reader settings ("Aa" menu): persist to localStorage, apply as data
 *   attributes on <html> (same attributes the pre-paint inline script sets —
 *   that script also runs first paint, this one only reacts to changes);
 * - book/chapter jump menu: close on outside click / Esc / navigation;
 * - note popovers on <mark data-note>: popover on desktop, CSS bottom sheet
 *   on narrow screens; Esc + outside click close; only one open at a time;
 *   URL hash tracks the open note (#note-ID) so notes can be shared;
 * - deep links: #v4 / #g-4 / #e-4 scroll+flash the row (stage 2 behaviour,
 *   moved here); loading a shared #note-ID URL opens that note.
 *
 * This file's listeners attach ONCE (document-level) and survive Astro's
 * ClientRouter page swaps; per-page re-wiring happens in init() on
 * astro:page-load. Without JS none of this runs: settings fall back to the
 * src/config.ts defaults baked into site.css, and notes are readable at the
 * end of the chapter.
 */
(() => {
  "use strict";

  const KEY = "tabyo-reader";
  const SETTING_KEYS = ["highlightGreek", "highlightEnglish", "highlights", "muteUntouched", "fontSize"];

  const doc = document;
  let docReady = false;

  /* ---------------------------------------------------------------- */
  /* Reader settings                                                  */
  /* ---------------------------------------------------------------- */

  function storedSettings() {
    let raw = {};
    try {
      raw = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch (_e) {
      /* corrupted storage: fall back to defaults */
    }
    const defaults = (window.__TABYO__ && window.__TABYO__.defaults) || {};
    const out = {};
    for (const k of SETTING_KEYS) out[k] = raw[k] != null ? raw[k] : defaults[k];
    return out;
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (_e) {
      /* private mode / storage disabled: settings simply don't persist */
    }
  }

  function applySettings(s) {
    const root = doc.documentElement;
    root.dataset.hlGreek = s.highlightGreek;
    root.dataset.hlEnglish = s.highlightEnglish;
    root.dataset.highlights = s.highlights;
    root.dataset.muteUntouched = s.muteUntouched;
    root.dataset.fontSize = s.fontSize;
  }

  function followSystemTheme() {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    doc.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    // System-following: when the OS theme changes, the site follows.
    mq.addEventListener("change", () => {
      doc.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    });
  }

  function syncSettingButtons(root, s) {
    for (const btn of root.querySelectorAll("button.set[data-setting]")) {
      const setting = btn.dataset.setting;
      const value = btn.dataset.value;
      if (setting in s) btn.setAttribute("aria-pressed", String(s[setting] === value));
    }
  }

  function wireSettings(root) {
    const wrap = doc.getElementById("settings");
    if (!wrap) return;

    const sync = () => syncSettingButtons(wrap, current);
    let current = storedSettings();
    applySettings(current);
    sync();

    // Any change: update state, persist, re-apply.
    wrap.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("button.set[data-setting]") : null;
      const reset = e.target instanceof Element ? e.target.closest("#settings-reset") : null;
      if (!btn && !reset) return;
      if (reset) {
        current = (window.__TABYO__ && window.__TABYO__.defaults) || {};
        saveSettings(current);
      } else if (btn) {
        const setting = btn.dataset.setting;
        current = { ...current, [setting]: btn.dataset.value };
        saveSettings(current);
      } else return;
      applySettings(current);
      sync();
    });

    // Close when a navigation happens from inside the menu (ClientRouter);
    // outside click / Esc closing is handled once, document-level, below.
    wrap.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest("a")) wrap.open = false;
    });
  }

  /* Document-level <details> menu handling for BOTH menus (settings + jump):
     outside pointerdown and Esc close them, with focus back on the summary.
     Wired ONCE — menus() re-queries per event, so ClientRouter page swaps are
     safe and listeners never accumulate. */
  function menus() {
    return [doc.getElementById("settings"), doc.querySelector("details.jump")].filter(
      (el) => el instanceof HTMLDetailsElement
    );
  }

  function wireDocMenuHandlers() {
    doc.addEventListener("pointerdown", (e) => {
      if (!(e.target instanceof Element)) return;
      for (const wrap of menus()) {
        if (wrap.open && !wrap.contains(e.target)) wrap.open = false;
      }
    });
    doc.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      for (const wrap of menus()) {
        if (!wrap.open) continue;
        e.stopPropagation();
        wrap.open = false;
        wrap.querySelector("summary")?.focus();
        break;
      }
    });
  }

  function wireMenus() {
    // Link-click closing for EVERY <details class="jump"> (header picker and
    // the reading-toolbar picker); outside click / Esc is document-level.
    for (const jump of doc.querySelectorAll("details.jump")) {
      jump.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest("a")) jump.open = false;
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Note popovers                                                    */
  /* ---------------------------------------------------------------- */

  const pop = {
    root: null, // popover container (created lazily per document body)
    body: null,
    kind: null,
    mark: null,
    raf: 0,
  };

  function createPopover() {
    const el = doc.createElement("div");
    el.className = "note-popover";
    el.id = "note-popover";
    el.setAttribute("role", "dialog");
    el.setAttribute("tabindex", "-1");
    const head = doc.createElement("div");
    head.className = "note-pop-head";
    const kind = doc.createElement("span");
    kind.className = "note-pop-kind";
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "note-pop-close";
    close.textContent = "Close";
    head.append(kind, close);
    const body = doc.createElement("div");
    body.className = "note-pop-body";
    el.append(head, body);
    close.addEventListener("click", () => closeNote());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeNote();
      }
    });
    return { el, kind, body };
  }

  /** Position the popover near the mark (viewport coords, position:fixed). */
  function placePopover(mark) {
    const rect = mark.getBoundingClientRect();
    const el = pop.root;
    el.style.visibility = "hidden";
    el.hidden = false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = doc.documentElement.clientWidth;
    const vh = window.innerHeight;
    let top = rect.bottom + 8;
    if (top + h > vh - 10) top = rect.top - h - 8;
    if (top < 8) top = Math.max(8, Math.min(rect.top, vh - h - 8));
    const left = Math.max(8, Math.min(rect.left, vw - w - 8));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.visibility = "";
  }

  function openNote(mark) {
    const id = mark.dataset.note;
    if (!id) return;
    closeNote();
    const content = doc.querySelector(`#notes .note[data-note-id="${CSS.escape(id)}"]`);
    if (!content) return;

    if (!pop.root || !pop.root.isConnected) {
      const created = createPopover();
      pop.root = created.el;
      pop.kind = created.kind;
      pop.body = created.body;
      doc.body.append(pop.root);
    }

    pop.kind.textContent = content.dataset.kind === "greek" ? "Greek note" : "English note";
    pop.root.setAttribute(
      "aria-label",
      `${pop.kind.textContent} on verse ${content.dataset.ref ?? "—"}`
    );
    const clone = content.cloneNode(true);
    clone.hidden = false;
    pop.body.replaceChildren(clone);
    pop.mark = mark;

    placePopover(mark);
    mark.setAttribute("aria-expanded", "true");
    mark.setAttribute("aria-controls", "note-popover");

    const nid = `note-${id}`;
    if (window.location.hash !== `#${nid}`) {
      history.replaceState(null, "", `#${nid}`);
    }
    pop.root.focus({ preventScroll: true });

    // Keep the popover glued to its mark on scroll (desktop only; the CSS
    // bottom sheet on narrow screens ignores these inline styles).
    const mqNarrow = window.matchMedia("(max-width: 760px)");
    const onScroll = () => {
      if (pop.raf) return;
      pop.raf = requestAnimationFrame(() => {
        pop.raf = 0;
        if (pop.mark) placePopover(pop.mark);
      });
    };
    if (!pop.onScroll || pop.mqNarrow !== mqNarrow) {
      window.removeEventListener("scroll", pop.onScroll, { capture: true });
    }
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    pop.onScroll = onScroll;
    pop.mqNarrow = mqNarrow;
  }

  function closeNote(restoreFocus) {
    if (pop.raf) {
      cancelAnimationFrame(pop.raf);
      pop.raf = 0;
    }
    if (pop.onScroll) {
      window.removeEventListener("scroll", pop.onScroll, { capture: true });
      pop.onScroll = null;
    }
    if (pop.root) pop.root.hidden = true;
    if (pop.mark) {
      pop.mark.removeAttribute("aria-expanded");
      pop.mark.removeAttribute("aria-controls");
    }
    const wasMark = pop.mark;
    pop.mark = null;
    if (restoreFocus && wasMark && wasMark.isConnected) wasMark.focus({ preventScroll: true });
    // Clear the hash when the note was open via that hash.
    if (window.location.hash.startsWith("#note-")) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  function toggleNote(mark) {
    if (pop.mark === mark && pop.root && !pop.root.hidden) {
      closeNote(true);
    } else {
      openNote(mark);
    }
  }

  // One delegated listener for all marks on every page (survives swaps).
  doc.addEventListener("click", (e) => {
    const mark = e.target instanceof Element ? e.target.closest("mark[data-note]") : null;
    if (!mark) return;
    // Outside-click closing must not swallow the click that opens this one.
    toggleNote(mark);
  });

  // Keyboard activation for <mark> (Enter / Space), which browsers don't
  // fire click for since it is not a button.
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const mark = e.target instanceof Element ? e.target.closest("mark[data-note]") : null;
    if (!mark) return;
    e.preventDefault();
    toggleNote(mark);
  });

  // Esc anywhere closes the note; outside pointerdown closes it too.
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (pop.mark) {
      e.stopPropagation();
      closeNote(true);
    }
  });

  doc.addEventListener("pointerdown", (e) => {
    if (!pop.mark) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (t.closest(".note-popover") || t.closest("mark[data-note]"))) return;
    closeNote(false);
  });

  /* ---------------------------------------------------------------- */
  /* Deep links (stage 2 behaviour, kept) + shared note hashes        */
  /* ---------------------------------------------------------------- */

  function handleHash() {
    const hash = window.location.hash;
    const noteHash = /^#note-(.+)$/.exec(hash);
    if (noteHash) {
      const mark = doc.querySelector(`mark[data-note="${CSS.escape(noteHash[1])}"]`);
      if (mark) {
        mark.scrollIntoView({ block: "center" });
        openNote(mark);
        return;
      }
    }
    // Keep #v4 / #g-4 / #e-4 working as before.
    const m = /^#(?:v(\d+)|g-(\d+)|e-(\d+))$/.exec(hash);
    if (!m) return;
    const n = m[1] ?? m[2] ?? m[3] ?? "";
    const verse =
      doc.getElementById(`g-${n}`) ?? doc.getElementById(`e-${n}`) ?? doc.getElementById(`v${n}`);
    const row = (verse instanceof HTMLElement && verse.closest(".row")) || (verse instanceof HTMLElement ? verse : null);
    if (!row || row.id === "") return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
    window.setTimeout(() => row.classList.remove("flash"), 1600);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  /* ---------------------------------------------------------------- */
  /* Per-page init (also runs on first load and after each swap)      */
  /* ---------------------------------------------------------------- */

  function init() {
    // Document-level wiring is once-only (survives swaps by design).
    if (!docReady) {
      docReady = true;
      followSystemTheme();
      wireDocMenuHandlers();
    }
    wireSettings(doc);
    wireMenus();
    // Marks announce that they open a dialog.
    for (const mark of doc.querySelectorAll("mark[data-note]")) {
      mark.setAttribute("aria-haspopup", "dialog");
      if (!mark.hasAttribute("aria-expanded")) mark.setAttribute("aria-expanded", "false");
    }
    handleHash();
  }

  // Re-create the popover host when the body changes (ClientRouter swap).
  doc.addEventListener("astro:after-swap", () => {
    pop.root = null;
    pop.body = null;
    pop.kind = null;
    pop.mark = null;
  });

  doc.addEventListener("astro:page-load", init);
})();
