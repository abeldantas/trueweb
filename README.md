# TrueWeb

> Put on the glasses. See the web as it is.

Save your brain. It's not too late.

The feed is engineered to take your attention, not to inform you. Titles are written to make you click, not to tell you what's inside. Thumbnails are faces mid-scream and arrows pointing at nothing. You scroll, you click, you lose an afternoon, and you learn nothing you'll remember tomorrow.

TrueWeb is the They Live glasses for that feed. It rewrites the clickbait titles and thumbnails in place into plain summaries of what each thing actually is, using an LLM you control. The point isn't to make the feed nicer. It's to make the manipulation visible, so you can notice how much of it you were swallowing.

## Before / after

The same YouTube home page, with the glasses off and on.

| Without TrueWeb | With TrueWeb |
| --- | --- |
| ![Raw YouTube feed: clickbait titles, faces, arrows, capitalized hooks](prints/before.jpeg) | ![Same feed through TrueWeb: sober cards with plain-language summaries](prints/after.png) |

Look at the left one for a second. Every title is a hook, every thumbnail is a face mid-scream, and none of it tells you what's inside. On the right, "WE BANNED AI (HERE'S WHY)" is just a sentence about what the video is. Once you've seen the two side by side, the left one is hard to unsee.

## What it does

- **Rewrites titles in place** into a short, plain headline that says what the thing actually is.
- **Replaces thumbnails** with a calm single-color card carrying the honest description.
- **Decodes with an LLM** (your key) to describe what each item genuinely delivers, factoring in the author/channel. Optionally fetches the real video description for a sharper summary.
- **Decorates Shorts** with a blunter, more cynical card instead of removing them.
- **Removes profile pictures / avatars** for a calmer feed.
- **Caches decodes for the session**, so toggling off/on is an instant before/after.
- **Light or dark widget**, on by default.

## Where it runs

TrueWeb only loads on **YouTube**. It does not run, read, or inject anywhere else. The whitelist is deliberately small and grows on purpose, not by accident.

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the TrueWeb toolbar icon, choose a provider, paste your API key, and Save.

## Configure

TrueWeb calls an LLM directly from your browser. In the popup:

- **Provider:** OpenAI-compatible (OpenAI, OpenRouter, Groq, …) or Anthropic.
- **API base URL:** e.g. `https://api.openai.com/v1`, or `https://openrouter.ai/api/v1`.
- **API key:** your provider key (stored locally in `chrome.storage.local`).
- **Model:** e.g. `gpt-4o-mini`, `openai/gpt-4o-mini`, `claude-haiku-4-5`.

The model must support structured/JSON-schema output (most current chat models do).

## Use

- Toggle: **Alt+Shift+Y** (or the floating widget).
- Decode visible items: **Alt+Shift+D**.
- On YouTube it turns on automatically.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: your key stays in your browser; only the titles/authors (and optional descriptions) of visible items are sent to the LLM provider *you* configure, only when decoding. No analytics, no servers operated by this project.

## Development

- Icons are generated from `icon.svg`:
  ```sh
  for s in 16 32 48 128; do rsvg-convert -w $s -h $s icon.svg -o icons/icon-$s.png; done
  ```
- Package for the Chrome Web Store:
  ```sh
  ./scripts/package.sh
  ```

## Extending the whitelist

Add domains to `content_scripts.matches` and `host_permissions` in `manifest.json`, and add a site adapter in `content.js` (`adapters`).

## License

MIT — see [LICENSE](LICENSE).

---

<sub>They Live (1988).</sub>
