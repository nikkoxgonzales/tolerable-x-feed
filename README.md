# Tolerable X Feed

**Are you tired of pretentious engagement-bait posts on X?**

> *"You wake up in 1999 with a laptop and a coding agent. What do you ship first?"*
> *"Name one engineer who writes better code than an LLM."*
> *"Major release is live today 🚀 $0.11 per 1M tokens, try it now →"*

Same here. Tolerable X Feed is a Tampermonkey userscript that reads your timeline and folds away the posts that exist only to farm replies or sell you something:

| Filter | Catches | How |
| --- | --- | --- |
| **Bait** | "Name one…", "You wake up in 1999…", "Be honest:…", would-you-rather and hot-take polls | AI ([Jev](https://openrouter.ai/typesafe/jev-1.13)) |
| **Promo** | Product launches, pricing drops, discount codes, webinars, Product Hunt begging, "try it now" links | AI ([Jev](https://openrouter.ai/typesafe/jev-1.13)) |
| **Ad** | Paid posts X labels as "Ad" | Read from the page, free |

![Filtered posts collapsed in the timeline](screenshots/collapsed.png)

Changed your mind? Click **Show** to open a post. It gets a light amber tint so you know it was flagged, and **Hide** folds it back.

![Revealed posts with a tint and a Hide button](screenshots/revealed.png)

## Features

- **Classifies by meaning, not keywords.** Jev, TypeSafe's decision model, scores every post from 0 to 1 for each filter. Real questions, news, research, releases you'd want to know about, and jokes stay in your feed.
- **Shows who posted it.** The collapsed bar shows the author's name, @handle, and a blue or gold verified badge.
- **Settings panel.** Turn each filter on or off, set its own threshold, choose collapse or remove, and see how much you've spent.
- **Cheap.** Posts are sent 8 per request, every score is cached, and paid ads never reach the AI. That comes to roughly **1–2¢ per 1,000 posts**.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open **[tolerable-x-feed.user.js](https://raw.githubusercontent.com/nikkoxgonzales/tolerable-x-feed/main/tolerable-x-feed.user.js)**. Tampermonkey will offer to install it.
3. Get an API key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) and add a few dollars of credit. A dollar goes a long way.
4. Open [x.com](https://x.com). The settings panel opens on first run so you can paste your key.

Updates are picked up automatically through Tampermonkey's update check.

## Settings

Open **Tampermonkey menu → Settings** on x.com:

- **Filters.** Toggle Ad, Bait, and Promo separately. Each AI filter has a threshold slider (default 60%): a post is hidden when its score is at or above it, so lower means stricter.
- **Display.** *Collapse* keeps a slim bar with Show/Hide; *Remove completely* takes the post out of the feed.
- **Score badges.** Shows `bait 0.12 · promo 0.03` on every post, which helps when picking thresholds.
- **API key** and **Clear cache**.

**Tampermonkey menu → Pause / resume** switches everything off without uninstalling.

## How it works

1. A `MutationObserver` watches the timeline for posts (`article[data-testid="tweet"]`).
2. Posts carrying X's "Ad" label are collapsed right away.
3. Every other post is queued and sent in batches to OpenRouter's [Decisions API](https://openrouter.ai/docs/guides/community/jev) (`POST /api/alpha/decisions`). Each post carries its text, the author's display name, and whether the account is unverified, verified, or a verified organization (gold check), and gets one yes/no (`noul`) question per filter. A few sample bait posts go along as examples.
4. Jev returns a probability per post per filter. Results are cached, and anything at or above a filter's threshold is collapsed.

**Accuracy** on a test set of 82 posts (the bait in [`twitter-bait-questions.txt`](twitter-bait-questions.txt), 10 promo posts, and 10 ordinary posts) at the default 60% threshold:

| | Flagged as bait | Flagged as promo |
| --- | --- | --- |
| Bait posts (62) | 62 | 0 |
| Promo posts (10) | 0 | 10 |
| Ordinary posts (10) | 1 ("Hot take: …", fair enough) | 0 |

News from organization accounts (Reuters, NASA) was correctly left alone by the promo filter.

## Privacy

- Post text, author display name, and verification type are sent to OpenRouter and TypeSafe to be classified. No @handles, account info, or browsing data are sent.
- Your API key stays in your browser's Tampermonkey storage and is only sent to `openrouter.ai`.

## Tuning

- Turn on **score badges**, see where your timeline sits, and adjust the thresholds.
- Edit `BAIT_EXAMPLES` or a filter's `question()` wording near the top of the script to fit what you see. Adding a new AI filter means adding one more entry to `FILTERS`.

If X changes its markup and the script stops finding posts or ads, please [open an issue](https://github.com/nikkoxgonzales/tolerable-x-feed/issues).

## License

MIT
