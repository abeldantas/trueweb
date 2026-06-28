# Changelog

## 0.1.0 (unreleased)

Initial version.

- In-place replacement of YouTube titles and thumbnails with sober cards (DeArrow-style: hide original, render beside it; resilient to YouTube's lockup DOM and node recycling).
- LLM decoding via an OpenAI-compatible provider or Anthropic, using your own API key, returning a short headline (for the title) and a fuller honest description (for the card).
- Author/channel is factored into the decode; optional fetching of the real video description for sharper summaries.
- Shorts decorated with a blunter "They Live"-style card instead of being removed; their original titles are hidden.
- Profile pictures / avatars removed.
- Session-persistent decode cache for instant before/after on toggle.
- Concurrency guard so repeated clicks don't produce overlapping results.
- Light or dark widget; on by default on YouTube.
- Infinite-scroll handling via a MutationObserver.
