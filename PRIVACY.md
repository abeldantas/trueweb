# TrueWeb Privacy Policy

TrueWeb is a browser extension that runs locally in your browser. It does not operate any servers and does not collect, sell, or share your personal data.

## What is stored

- **Your settings and API key** are stored in `chrome.storage.local`, on your device only. The API key is never transmitted anywhere except to the LLM provider you configure, as part of your own API requests.

## What is sent, and where

When you decode items, TrueWeb sends the following to the LLM provider **you** choose (e.g. OpenAI, OpenRouter, Anthropic), using **your** API key:

- The visible items' titles and author/channel names.
- Optionally, an excerpt of a YouTube video's public description (only if "Fetch descriptions" is enabled), fetched from YouTube.

No browsing history, no personal identifiers, and no data from non-whitelisted sites are sent. TrueWeb only runs on YouTube.

Your use of a third-party LLM provider is governed by that provider's privacy policy and terms.

## What is NOT done

- No analytics or telemetry.
- No tracking across sites.
- No data sent to the extension authors or any first-party server (there is none).

## Contact

For questions, open an issue in the project repository.
