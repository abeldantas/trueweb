// TrueWeb content script.
// In-place replacement (DeArrow-style): keep the site's layout, but swap each
// item's thumbnail for a sober card and replace its title text. Two states:
// off / on. Heuristic title-cleaning is instant + local; "Decode" upgrades the
// titles to honest LLM-written descriptions on demand.
//
// Why we don't just overwrite the title node: YouTube (Polymer) re-binds title
// text and recycles DOM nodes on scroll, so an overwrite gets clobbered or ends
// up on the wrong video. Like DeArrow, we hide the original element and render
// our own element beside it, then re-apply via a MutationObserver.

(() => {
  if (window.__trueWebLoaded) return;
  window.__trueWebLoaded = true;

  const MODES = ["off", "on"];
  const MODE_LABEL = { off: "Glasses off", on: "Glasses on" };

  let mode = "off";
  let hud = null;
  let settings = { replaceThumbs: true, decorateShorts: true, removeAvatars: true, autoDecode: true, theme: "dark", billboard: false };
  let observer = null;
  let rescanTimer = null;
  let autoDecodeTimer = null;
  const registry = new Map(); // id -> rec
  const decodeCache = new Map(); // stable key (href|title) -> { headline, honest, kind }
  let decoding = false; // guard against overlapping decode requests
  let nextId = 1;

  // ---- Heuristic bait scoring -------------------------------------------

  const BAIT_PHRASES = [
    "you won't believe", "you wont believe", "shocking", "gone wrong",
    "this is why", "the truth about", "doctors hate", "what happened next",
    "will blow your mind", "before it's deleted", "before its deleted",
    "watch before", "they don't want you to know", "the real reason",
    "no one is talking about", "changed my life", "wait for it", "must see",
    "must watch", "agree?", "thoughts?", "comment below", "tag someone",
    "who else", "let that sink in", "read that again", "unpopular opinion",
  ];

  function baitScore(text) {
    if (!text) return { score: 0, reasons: [] };
    const t = text.trim();
    const lower = t.toLowerCase();
    let score = 0;
    const reasons = [];

    const letters = t.replace(/[^A-Za-z]/g, "");
    const caps = t.replace(/[^A-Z]/g, "");
    if (letters.length > 6 && caps.length / letters.length > 0.6) {
      score += 30; reasons.push("ALL CAPS");
    }
    const bangs = (t.match(/[!?]/g) || []).length;
    if (bangs >= 3) { score += 20; reasons.push("punctuation spam"); }
    else if (bangs === 2) score += 8;

    const emoji = (t.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
    if (emoji >= 3) { score += 20; reasons.push("emoji spam"); }
    else if (emoji >= 1) score += 6;

    let phraseHits = 0;
    for (const p of BAIT_PHRASES) if (lower.includes(p)) phraseHits++;
    if (phraseHits) { score += Math.min(40, phraseHits * 22); reasons.push("bait phrasing"); }

    return { score: Math.min(100, score), reasons };
  }

  function scoreTier(score) {
    if (score >= 50) return "high";
    if (score >= 25) return "med";
    return "low";
  }

  // Sober display version of a title: drop emoji, soften ALL-CAPS, calm punctuation.
  function cleanTitle(t) {
    let s = (t || "")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    s = s.replace(/\b[A-Z]{4,}\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
    s = s.replace(/[!?]{2,}/g, "!");
    return s;
  }

  // ---- Site adapters -----------------------------------------------------

  const host = location.hostname;

  const adapters = {
    youtube: {
      match: () => /(^|\.)youtube\.com$/.test(host),
      getItems() {
        const out = [];
        // New "lockup view model" DOM, plus legacy #video-title as fallback.
        const sel =
          "a.ytLockupMetadataViewModelTitle, a#video-title, #video-title-link, yt-formatted-string#video-title";
        document.querySelectorAll(sel).forEach((el) => {
          const title = (el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
          if (!title) return;
          const card =
            el.closest(
              "yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer"
            ) || el.parentElement;
          const channel =
            card?.querySelector('a[href^="/@"], a[href^="/channel/"], a[href^="/c/"]')?.textContent?.trim() ||
            card?.querySelector("ytd-channel-name #text, .ytd-channel-name")?.textContent?.trim() ||
            "";
          const href = el.href || el.closest("a")?.href || "";
          out.push({ el: card || el, titleEl: el, title, context: channel ? "channel: " + channel : "", href });
        });
        return out;
      },
    },
    generic: {
      match: () => true,
      getItems() {
        const out = [];
        const seen = new Set();
        document.querySelectorAll("h1, h2, h3, a[href]").forEach((el) => {
          const title = (el.textContent || "").trim().replace(/\s+/g, " ");
          if (title.length < 30 || title.length > 200) return;
          if (seen.has(title) || el.closest(".tw-hud")) return;
          seen.add(title);
          const link = el.matches("a") ? el : el.querySelector("a") || el.closest("a");
          out.push({ el, titleEl: el, title, context: "", href: link?.href || "" });
        });
        return out;
      },
    },
  };

  function pickAdapter() {
    return [adapters.youtube].find((a) => a.match()) || adapters.generic;
  }

  // ---- In-place replacement primitives ----------------------------------

  function readTitle(el) {
    return (el.textContent || "").trim();
  }

  // Render our own title element beside the original and hide the original.
  // Returns the custom element so callers can update its text later.
  function makeCustomTitle(el, text, href) {
    const custom = document.createElement("span");
    custom.className = "tw-title";
    custom.textContent = text;
    if (href) {
      custom.addEventListener("click", () => { location.href = href; });
    }
    el.style.setProperty("display", "none", "important");
    el.insertAdjacentElement("afterend", custom);
    return custom;
  }

  // Overlay a sober single-color text card on a given thumbnail element.
  function buildCard(thumb, displayTitle, opts) {
    opts = opts || {};
    if (!thumb) return null;
    let overlay = thumb.querySelector(":scope > .tw-thumbcard");
    if (overlay) {
      const t = overlay.querySelector(".tw-thumbcard__title");
      if (t) t.textContent = displayTitle;
      if (opts.tier) overlay.setAttribute("data-score", opts.tier);
      return t;
    }
    if (getComputedStyle(thumb).position === "static") thumb.style.position = "relative";

    overlay = document.createElement("div");
    overlay.className = "tw-thumbcard" + (opts.variant === "short" ? " tw-thumbcard--short" : "");
    if (opts.tier) overlay.setAttribute("data-score", opts.tier);

    const chip = document.createElement("span");
    chip.className = "tw-thumbcard__chip";
    chip.textContent = opts.chip || "TrueWeb";
    const title = document.createElement("div");
    title.className = "tw-thumbcard__title";
    title.textContent = displayTitle;
    const hint = document.createElement("span");
    hint.className = "tw-thumbcard__hint";
    hint.textContent = opts.hint || "click to watch";

    overlay.append(chip, title, hint);
    overlay.addEventListener("click", () => {
      const a = thumb.matches("a") ? thumb : thumb.querySelector("a");
      if (a?.href) location.href = a.href;
    });
    thumb.appendChild(overlay);
    return title;
  }

  // Cover a YouTube video thumbnail with a sober card.
  function replaceThumb(card, displayTitle, tier) {
    const thumb = card?.querySelector?.(
      "a.ytLockupViewModelContentImage, ytd-thumbnail, a#thumbnail, a.ytd-thumbnail"
    );
    return buildCard(thumb, displayTitle, { tier, chip: "TrueWeb", hint: "click to watch" });
  }

  // ---- Shorts decoration -------------------------------------------------
  // Shorts stay in the feed, but their thumbnails get a starker, more cynical
  // "They Live" card. Keyed off the /shorts/ URL so it survives DOM churn.

  const SHORT_HINTS = [
    "engineered for endless scroll",
    "built to keep you here",
    "dopamine, 30 seconds at a time",
    "designed to autoplay the next one",
    "your attention is the product",
  ];

  const SHORT_CONTEXT =
    "format: YouTube Short — a vertical short-form video built for quick, repeatable dopamine hits, " +
    "usually a brief attention-grab. If the real substance is unclear, say so plainly and note it is short-form filler / brain-rot.";

  function decorateShorts() {
    document.querySelectorAll('a[href*="/shorts/"]').forEach((a) => {
      const lockup =
        a.closest(
          "ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-rich-item-renderer, yt-lockup-view-model"
        ) || a.parentElement;
      // The thumbnail is the shorts link that wraps an image.
      const thumb = lockup?.querySelector('a[href*="/shorts/"]') || a;
      if (!thumb || thumb.dataset.twShortId) return;
      const raw =
        (lockup?.querySelector('[class*="title" i], h3')?.textContent ||
          a.getAttribute("aria-label") ||
          a.textContent ||
          "Short").trim();
      const title = cleanTitle(raw).replace(/\s*[-–]\s*\d[\d.,]*[KMB]?\s*views?.*$/i, "").trim() || "Short";
      const cardTitleEl = buildCard(thumb, title, {
        variant: "short",
        chip: "SHORT",
        hint: SHORT_HINTS[title.length % SHORT_HINTS.length],
      });
      const id = "tw" + nextId++;
      thumb.dataset.twShortId = id;
      // Register so Shorts get decoded too, with format context for the LLM.
      const rec = {
        el: lockup || thumb, titleEl: null, custom: null, thumbTitleEl: cardTitleEl,
        original: title, href: thumb.href || a.href, context: SHORT_CONTEXT, decoded: false, isShort: true,
      };
      registry.set(id, rec);
      applyCacheIfAny(rec);

      // Hide the Short's own title text shown below the thumbnail — the card
      // already carries the title/description, so the bold original is redundant.
      lockup
        ?.querySelectorAll('a[href*="/shorts/"], .shortsLockupViewModelHostMetadataTitle, h3')
        .forEach((t) => {
          if (t === thumb || thumb.contains(t) || !(t.textContent || "").trim()) return;
          t.style.setProperty("display", "none", "important");
          t.dataset.twHidden = "1";
        });
    });
  }

  // ---- Apply / clear -----------------------------------------------------

  function applyToItem(rec, sourceTitle, isYouTube, newHref) {
    const display = cleanTitle(sourceTitle);
    const tier = scoreTier(baitScore(sourceTitle).score);
    if (newHref) rec.href = newHref;
    rec.original = sourceTitle;
    rec.decoded = false;
    if (rec.custom) {
      rec.custom.textContent = display;
      rec.custom.classList.remove("tw-honest");
    }
    if (isYouTube && settings.replaceThumbs) {
      rec.thumbTitleEl = replaceThumb(rec.el, display, tier);
    }
    applyCacheIfAny(rec);
  }

  function applyReplace() {
    const isYouTube = adapters.youtube.match();
    if (isYouTube && settings.decorateShorts) decorateShorts();
    const items = pickAdapter().getItems();
    for (const it of items) {
      const el = it.titleEl;
      if (!el) continue;
      const live = readTitle(el);
      if (!live) continue;

      const id = el.dataset.twId;
      if (id) {
        const rec = registry.get(id);
        // Node recycled with new video data -> refresh from the new title.
        if (rec && live !== rec.original && live !== (rec.custom?.textContent || "")) {
          applyToItem(rec, live, isYouTube, el.href || el.closest("a")?.href);
        }
        continue;
      }

      const newId = "tw" + nextId++;
      el.dataset.twId = newId;
      const display = cleanTitle(live);
      const tier = scoreTier(baitScore(live).score);
      const custom = makeCustomTitle(el, display, it.href);
      const rec = {
        el: it.el, titleEl: el, custom, original: live, href: it.href,
        context: it.context, decoded: false, thumbTitleEl: null,
      };
      registry.set(newId, rec);
      if (isYouTube && settings.replaceThumbs) {
        rec.thumbTitleEl = replaceThumb(it.el, display, tier);
      }
      applyCacheIfAny(rec);
    }
    updateHud();
  }

  function clearAll() {
    registry.forEach((rec) => {
      rec.custom?.remove();
      if (rec.titleEl) {
        rec.titleEl.style.removeProperty("display");
        if (rec.titleEl.dataset) delete rec.titleEl.dataset.twId;
      }
    });
    document.querySelectorAll(".tw-thumbcard").forEach((n) => n.remove());
    document.querySelectorAll("[data-tw-short-id]").forEach((e) => { delete e.dataset.twShortId; });
    document.querySelectorAll("[data-tw-hidden]").forEach((e) => {
      e.style.removeProperty("display");
      delete e.dataset.twHidden;
    });
    registry.clear();
    document.documentElement.classList.remove("tw-hide-avatars");
  }

  function setMode(next) {
    clearAll();
    mode = next;
    if (mode === "on") {
      if (settings.removeAvatars) document.documentElement.classList.add("tw-hide-avatars");
      applyReplace();
      startObserver();
      scheduleAutoDecode();
    } else {
      stopObserver();
    }
    updateHud();
  }

  function cycle() {
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  }

  // ---- Infinite-scroll handling -----------------------------------------
  // applyReplace() is incremental (skips processed nodes, refreshes recycled
  // ones), so re-running on mutation keeps lazy-loaded items covered. We
  // disconnect while applying so our own inserts don't re-trigger the observer.

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      if (mode !== "on") return;
      observer?.disconnect();
      applyReplace();
      observer?.observe(document.body, { childList: true, subtree: true });
      scheduleAutoDecode();
    }, 400);
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(scheduleRescan);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    clearTimeout(rescanTimer);
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  // ---- Decode (LLM honest titles) ---------------------------------------

  function cacheKey(rec) {
    return rec.href || rec.original;
  }

  // Write a decoded result onto an item. The in-place title gets the SHORT
  // headline; the thumbnail card gets the fuller description — complementary,
  // not duplicated. Items without a card (thumbnails off) put the
  // description on the title.
  function applyDecoded(rec, data) {
    const headline = data.headline || data.honest;
    const honest = (data.kind && data.kind !== "informative" ? "[" + data.kind + "] " : "") + data.honest;
    if (rec.custom && rec.thumbTitleEl) {
      rec.custom.textContent = headline;
      rec.thumbTitleEl.textContent = honest;
    } else if (rec.thumbTitleEl) {
      rec.thumbTitleEl.textContent = honest;
    } else if (rec.custom) {
      rec.custom.textContent = honest;
    }
    rec.decoded = true;
  }

  // Apply a cached decode instantly (no LLM call) if we've seen this item this session.
  function applyCacheIfAny(rec) {
    const cached = decodeCache.get(cacheKey(rec));
    if (cached) applyDecoded(rec, cached);
    return !!cached;
  }

  function markPending(rec, on) {
    const card = rec.thumbTitleEl && rec.thumbTitleEl.closest(".tw-thumbcard");
    [rec.custom, card].forEach((el) => el && el.classList.toggle("tw-decoding", !!on));
  }

  function collectForDecode() {
    const items = [];
    registry.forEach((rec, id) => {
      if (rec.decoded) return;
      const r = rec.el?.getBoundingClientRect?.();
      if (!r || r.bottom < -200 || r.top > window.innerHeight + 600) return;
      items.push({ id, title: rec.original, context: rec.context, href: rec.href });
    });
    return items;
  }

  function decodeVisible(opts) {
    const auto = opts && opts.auto;
    if (mode !== "on") { if (!auto) flash("Turn TrueWeb on first."); return; }
    if (decoding) { if (!auto) flash("Still decoding…"); return; } // no overlapping runs
    const items = collectForDecode();
    if (!items.length) { if (!auto) flash("Nothing new to decode."); return; }

    decoding = true;
    const pending = items.map((i) => registry.get(i.id)).filter(Boolean);
    pending.forEach((r) => markPending(r, true));
    flash("Decoding " + items.length + "…", true);

    chrome.runtime.sendMessage({ type: "decode", items }, (resp) => {
      decoding = false;
      pending.forEach((r) => markPending(r, false));
      if (!resp || resp.error) {
        if (!auto) flash(resp?.error || "Decode failed.", false, true);
        else updateHud();
        return;
      }
      let n = 0;
      for (const out of resp.items || []) {
        const rec = registry.get(out.id);
        if (!rec) continue;
        applyDecoded(rec, out);
        decodeCache.set(cacheKey(rec), { headline: out.headline, honest: out.honest, kind: out.kind });
        n++;
      }
      flash("Decoded " + n + ".");
      scheduleAutoDecode(); // pick up any items that loaded during this request
    });
  }

  function scheduleAutoDecode() {
    if (!settings.autoDecode) return;
    clearTimeout(autoDecodeTimer);
    autoDecodeTimer = setTimeout(() => {
      if (mode === "on") decodeVisible({ auto: true });
    }, 700);
  }

  // ---- HUD ---------------------------------------------------------------

  function buildHud() {
    hud = document.createElement("div");
    hud.className = "tw-hud";
    hud.innerHTML =
      '<span class="tw-hud__dot"></span>' +
      '<span class="tw-hud__label"></span>' +
      '<button data-act="cycle" title="Toggle (Alt+Shift+Y)">Toggle</button>' +
      '<button data-act="decode" title="Decode visible (Alt+Shift+D)">Decode</button>' +
      '<button data-act="theme" title="Light / dark widget">☀</button>';
    hud.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (act === "cycle") cycle();
      else if (act === "decode") decodeVisible();
      else if (act === "theme") toggleTheme();
    });
    document.body.appendChild(hud);
    updateHud();
  }

  let flashTimer = null;
  function flash(text, sticky, isError) {
    const label = hud?.querySelector(".tw-hud__label");
    if (!label) return;
    label.textContent = text;
    label.style.color = isError ? "#e08a72" : "";
    clearTimeout(flashTimer);
    if (!sticky) flashTimer = setTimeout(updateHud, 2500);
  }

  function updateHud() {
    if (!hud) return;
    hud.setAttribute("data-mode", mode);
    const label = hud.querySelector(".tw-hud__label");
    if (label) { label.textContent = MODE_LABEL[mode]; label.style.color = ""; }
    const decodeBtn = hud.querySelector('[data-act="decode"]');
    if (decodeBtn) decodeBtn.disabled = mode === "off";
  }

  function applyTheme(theme) {
    settings.theme = theme === "light" ? "light" : "dark";
    document.documentElement.classList.toggle("tw-theme-light", settings.theme === "light");
    const btn = hud?.querySelector('[data-act="theme"]');
    if (btn) btn.textContent = settings.theme === "light" ? "☾" : "☀";
  }

  function toggleTheme() {
    const next = settings.theme === "light" ? "dark" : "light";
    applyTheme(next);
    chrome.storage.local.set({ theme: next });
  }

  // "Billboard" = the They Live ALL-CAPS hidden-message aesthetic. Off by
  // default because it hurts readability; opt in via the popup.
  function applyBillboard(on) {
    settings.billboard = !!on;
    document.documentElement.classList.toggle("tw-billboard", settings.billboard);
  }

  // ---- Wiring ------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "cycle-mode") cycle();
    else if (msg.type === "decode-visible") decodeVisible();
    else if (msg.type === "set-mode") {
      // Accept legacy mode names from older popups.
      const m = msg.mode === "annotate" || msg.mode === "text" ? "on" : msg.mode;
      if (MODES.includes(m)) setMode(m);
    }
  });

  function init() {
    if (!document.body) { setTimeout(init, 100); return; }
    buildHud();
    chrome.storage.local.get(
      { defaultMode: "on", replaceThumbs: true, decorateShorts: true, removeAvatars: true, autoDecode: true, theme: "dark", billboard: false },
      (s) => {
        settings.replaceThumbs = s.replaceThumbs !== false;
        settings.decorateShorts = s.decorateShorts !== false;
        settings.removeAvatars = s.removeAvatars !== false;
        settings.autoDecode = s.autoDecode !== false;
        applyTheme(s.theme);
        applyBillboard(s.billboard === true);
        const dm = s.defaultMode === "annotate" || s.defaultMode === "text" ? "on" : s.defaultMode;
        if (dm && dm !== "off") setMode(dm);
      }
    );
  }
  init();
})();
