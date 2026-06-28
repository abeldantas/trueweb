const DEFAULTS = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  defaultMode: "on",
  theme: "dark",
  replaceThumbs: true,
  decorateShorts: true,
  removeAvatars: true,
  autoDecode: true,
  fetchDescriptions: true,
  billboard: false,
};

const $ = (id) => document.getElementById(id);

const HINTS = {
  openai:
    "OpenAI: base https://api.openai.com/v1, model e.g. gpt-4o-mini. " +
    "OpenRouter: base https://openrouter.ai/api/v1, model e.g. openai/gpt-4o-mini or google/gemini-2.0-flash-001.",
  anthropic: "Anthropic: base URL is ignored. Model e.g. claude-haiku-4-5. Key starts with sk-ant-.",
};

function syncProviderUI() {
  const p = $("provider").value;
  const isAnthropic = p === "anthropic";
  $("baseUrl").disabled = isAnthropic;
  $("baseUrl").style.opacity = isAnthropic ? "0.5" : "1";
  $("modelHint").textContent = HINTS[p] || "";
}

function load() {
  chrome.storage.local.get(DEFAULTS, (s) => {
    $("provider").value = s.provider || "openai";
    $("baseUrl").value = s.baseUrl || "https://api.openai.com/v1";
    $("apiKey").value = s.apiKey || "";
    $("model").value = s.model || "gpt-4o-mini";
    $("defaultMode").value = s.defaultMode || "off";
    $("replaceThumbs").checked = s.replaceThumbs !== false;
    $("decorateShorts").checked = s.decorateShorts !== false;
    $("removeAvatars").checked = s.removeAvatars !== false;
    $("autoDecode").checked = s.autoDecode !== false;
    $("fetchDescriptions").checked = s.fetchDescriptions !== false;
    $("billboard").checked = s.billboard === true;
    syncProviderUI();
  });
}

function save() {
  const settings = {
    provider: $("provider").value,
    baseUrl: $("baseUrl").value.trim() || "https://api.openai.com/v1",
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    defaultMode: $("defaultMode").value,
    replaceThumbs: $("replaceThumbs").checked,
    decorateShorts: $("decorateShorts").checked,
    removeAvatars: $("removeAvatars").checked,
    autoDecode: $("autoDecode").checked,
    fetchDescriptions: $("fetchDescriptions").checked,
    billboard: $("billboard").checked,
  };
  chrome.storage.local.set(settings, () => {
    const status = $("status");
    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1500);
  });
}

async function applyMode(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "set-mode", mode }).catch(() => {});
  window.close();
}

$("save").addEventListener("click", save);
$("provider").addEventListener("change", () => {
  // Offer a sensible default base URL / model when switching providers.
  const p = $("provider").value;
  if (p === "openai" && !$("baseUrl").value.trim()) $("baseUrl").value = "https://api.openai.com/v1";
  syncProviderUI();
});
document.querySelectorAll(".modes button").forEach((b) => {
  b.addEventListener("click", () => applyMode(b.dataset.mode));
});

load();
