# X Bait Post Filter

**Are you tired of pretentious engagement-bait posts on X?**

> *"You wake up in 1999 with a laptop and a coding agent. What do you ship first?"*
> *"Name one engineer who writes better code than an LLM."*
> *"Be honest: are you using AI to code faster, or because you forgot how to code?"*

Same here. This Tampermonkey userscript reads your timeline and collapses posts that exist only to farm replies. It uses [Jev](https://openrouter.ai/typesafe/jev-1.13), TypeSafe's decision model on OpenRouter, to give each post a bait probability from 0 to 1. Posts above your threshold get folded away.

![Bait posts collapsed in the timeline](screenshots/collapsed.png)

Changed your mind? Click **Show** to open a post. It gets a light amber tint so you know it was flagged, and **Hide** folds it back.

![Revealed bait posts with a tint and a Hide button](screenshots/revealed.png)

## Features

- **Classifies by meaning, not keywords.** It catches open-ended hypotheticals, "name one…", "would you rather", "be honest:" and hot-take polls, and leaves real questions, news, releases and jokes alone.
- **Shows who posted it.** The collapsed bar shows the author's name, @handle and verified badge.
- **Collapse or hide.** Keep a slim bar with Show/Hide, or remove bait posts completely.
- **Cheap.** Posts are sent 8 per request, and every score is cached, so the same post is never paid for twice. That comes to roughly **$0.01 per 1,000 posts**.
- **Adjustable.** Set the threshold, turn on score badges for tuning, pause it, or clear the cache from the Tampermonkey menu.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open **[x-bait-filter.user.js](https://raw.githubusercontent.com/nikkoxgonzales/x-bait-filter/main/x-bait-filter.user.js)**. Tampermonkey will offer to install it.
3. Get an API key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) and add a few dollars of credit. A dollar goes a long way.
4. Open [x.com](https://x.com). The script asks for your key on first run.

Updates are picked up automatically through Tampermonkey's update check.

## Settings

Everything is in the Tampermonkey menu while you're on x.com:

| Menu item | What it does |
| --- | --- |
| Set OpenRouter API key | Saves your key in Tampermonkey's local storage |
| Set threshold | Hides posts scoring at or above this value. Default `0.6`; lower is stricter |
| Toggle mode (collapse / hide) | `collapse` keeps a bar with Show/Hide; `hide` removes the post entirely |
| Toggle score badges | Shows `bait 0.12` on every post, which helps when picking a threshold |
| Pause / resume filtering | Turns the filter off without uninstalling |
| Clear verdict cache | Forgets all cached scores |

## How it works

1. A `MutationObserver` watches the timeline for posts (`article[data-testid="tweet"]`).
2. New post text is queued and sent in batches to OpenRouter's [Decisions API](https://openrouter.ai/docs/guides/community/jev) (`POST /api/alpha/decisions`), with one yes/no (`noul`) question per post: *is this engagement bait?* A few sample bait posts are sent along as examples.
3. Jev returns a probability per post. Results are cached by a hash of the post text, and anything at or above the threshold is collapsed.

On the sample set in [`twitter-bait-questions.txt`](twitter-bait-questions.txt), the default threshold caught 61–62 of 62 bait posts, with no false positives on a set of ordinary posts (release notes, news, genuine help questions, jokes).

## Privacy

- Post text from your timeline is sent to OpenRouter and TypeSafe to be classified. Nothing else is: no usernames, no account info, no browsing data.
- Your API key stays in your browser's Tampermonkey storage and is only sent to `openrouter.ai`.

## Tuning

Seeing bait slip through, or good posts getting hidden?

- Turn on **score badges** and see where your timeline sits, then adjust the **threshold**.
- Edit the `EXAMPLES` array or the `question()` wording at the top of the script to fit the kind of bait you see.

If X changes its markup and the script stops finding posts, please [open an issue](https://github.com/nikkoxgonzales/x-bait-filter/issues).

## License

MIT
