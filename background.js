// TrueWeb background service worker.
// Holds the Anthropic API call so the key is read here, and relays keyboard
// commands to the active tab's content script.

const DEFAULTS = {
  provider: "openai", // "openai" (OpenAI-compatible) | "anthropic"
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  defaultMode: "on",
  fetchDescriptions: true,
};

const SYSTEM_PROMPT = [
  "You are a lens that tells a reader what a video or post is genuinely about, so they can decide whether to open it without being manipulated by clickbait.",
  "For each item you are given its title, channel/author, and sometimes a description excerpt and a format note.",
  "Return two things:",
  "1) headline: a SHORT plain replacement title, max 8 words, that states what the content actually is and who it is for, so the reader can tell at a glance whether it is relevant to them. No hype, no curiosity gaps.",
  "2) honest: ONE clear sentence, max 28 words, describing what the content actually delivers — the topic, what is shown or argued, and the practical takeaway when it can be inferred.",
  "Consider the author/channel: their typical domain, expertise, and track record shape what the item most likely is; reflect that when useful.",
  "If a description excerpt is provided, prefer it as the source of truth over the title.",
  "Strip hype, ALL-CAPS, and emotional bait from both fields.",
  "If an item is an advertisement, or pure engagement-bait with no real content, say so plainly.",
  "Never invent specifics not supported by the provided text. If the real content is unknowable, state what the title promises and that the payoff is unverified.",
].join(" ");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          headline: { type: "string" },
          honest: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "informative",
              "clickbait",
              "ad",
              "engagement-bait",
              "outrage",
              "other",
            ],
          },
        },
        required: ["id", "headline", "honest", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (s) => resolve(s));
  });
}

function buildUserText(items) {
  return (
    "Decode these items. Return one entry per id.\n\n" +
    JSON.stringify(items.map((i) => ({ id: i.id, title: i.title, context: i.context || "" })))
  );
}

// Run an async fn over items with a small concurrency cap.
async function withConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Best-effort: scrape a YouTube watch page for the video's real description.
// No API key needed; the background worker has cross-origin access.
async function fetchDescription(href) {
  try {
    const u = new URL(href, "https://www.youtube.com");
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return "";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(u.href, { signal: ctrl.signal, credentials: "omit" });
    clearTimeout(timer);
    if (!res.ok) return "";
    const html = await res.text();
    const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (!m) return "";
    const d = m[1]
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/\s+/g, " ")
      .trim();
    return d.slice(0, 500);
  } catch {
    return "";
  }
}

// Lazily enrich items with descriptions (capped) before decoding.
async function enrichWithDescriptions(items) {
  const targets = items.filter((i) => i.href).slice(0, 12);
  const descs = await withConcurrency(targets, 4, (it) => fetchDescription(it.href));
  targets.forEach((it, idx) => {
    if (descs[idx]) it.context = (it.context ? it.context + " | " : "") + "description: " + descs[idx];
  });
}

async function decodeAnthropic(settings, items) {
  const body = {
    model: settings.model || "claude-haiku-4-5",
    max_tokens: 4096,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: buildUserText(items) }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) return { error: `API ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) return { error: "Empty response from API." };
  return { items: (JSON.parse(textBlock.text).items) || [] };
}

// OpenAI-compatible: works with OpenAI, OpenRouter, Groq, Together, etc.
async function decodeOpenAICompatible(settings, items) {
  const base = (settings.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const body = {
    model: settings.model || "gpt-4o-mini",
    max_tokens: 4096,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserText(items) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "trueweb_labels", strict: true, schema: OUTPUT_SCHEMA },
    },
  };

  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + settings.apiKey,
      // Harmless extras some gateways (OpenRouter) like to see:
      "HTTP-Referer": "https://trueweb.extension",
      "X-Title": "TrueWeb",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) return { error: `API ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return { error: "Empty response from API." };
  return { items: (JSON.parse(content).items) || [] };
}

async function decode(items) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { error: "No API key set. Open the TrueWeb popup and paste your API key." };
  }
  try {
    if (settings.fetchDescriptions) await enrichWithDescriptions(items);
    return settings.provider === "anthropic"
      ? await decodeAnthropic(settings, items)
      : await decodeOpenAICompatible(settings, items);
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "decode") {
    decode(msg.items).then(sendResponse);
    return true; // async
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const type = command === "cycle-mode" ? "cycle-mode" : "decode-visible";
  chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
});
