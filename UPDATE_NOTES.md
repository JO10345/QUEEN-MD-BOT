# Queen MD Bot — repaired build

## October 2026 fixes

- `!yt` search now uses EliteProTech's confirmed `/search/ytsearch?q=...`
  endpoint first, with Botcahx as a fallback when `BOTCAHX_API_KEY` is set.
- YouTube downloads now use Botcahx's documented downloader API first, with
  David Cyril as an API-only fallback. The old direct `ytdl-core` YouTube
  fallback was removed because it triggered YouTube's sign-in/bot challenge.
- YouTube result lists are deduplicated, and user-facing download errors no
  longer expose low-level YouTube bot-check or CDN error text.
- The Botcahx audio URL is currently served as AAC/M4A despite its `mp3` field
  name; the bot now detects the actual file type and sends the correct MIME.
- `!mp3` now tries Nexray's `/downloader/ytplay` as a search-based fallback
  after the configured providers, using the original song query or pasted link.
- `!music` now falls back to Nexray's `ytplay` endpoint when David Cyril's
  `/play` call fails, and audio files are checked for valid media bytes before
  being sent.
- `!sp` and `!spotify` use Nexray Spotify search first, show numbered results,
  and now try Nexray's Spotify downloader before the David Cyril download APIs
  when `!sp 1`, `!sp 2`, etc. is selected.
- `!soundcloud` and `!sc` now accept numbered search-result selections and pass
  the chosen track URL to Nexray's SoundCloud downloader.
- The chatbot now tries David Cyril's Claude Sonnet 4.6 and GPT-5 endpoints
  before the older David endpoints, with text parsing for nested AI responses.
- View-once handling now supports audio/voice messages in automatic capture
  and `!vv`; image and video handling remains supported.
- `!fb` / `!fbdl` now tries Botcahx when `BOTCAHX_API_KEY` is configured, then
  GTech, then David Cyril; both new response formats are normalized, and failed
  CDN error pages are rejected instead of being sent as videos.
- `!autostatus react` now works independently of auto-view and targets the
  status poster; auto-replies quote the status when WhatsApp supplies its media.
- `!autoreact emoji ❤️ 🔥 😍` saves exactly three custom emoji and turns
  reactions on. Plain `!autoreact on` continues using the default random pool.
- Anti-Delete settings and recovered-message caches are keyed by paired
  WhatsApp account. Recoveries go to that paired account, not `OWNER_NUMBER`,
  and use the recovered-message layout shown in the supplied screenshot.
- Anti-Delete now recognizes Baileys revoke protocol messages in `messages.upsert`,
  revoke stubs in `messages.update`, and the existing `messages.delete` event.
  Its in-memory cache now retains up to 1,000 recent messages across sessions.
- Anti-Delete now pre-caches small voice/audio messages within strict memory
  limits, uses Baileys buffer-download mode for lazy media, and deduplicates
  simultaneous revoke events so one deletion does not send duplicate notices.
- Use the environment variables in `1.env.example` for provider keys; do not
  paste live keys into the source archive.

This build includes:

- The uploaded latest bot baseline, including the additional Gemini, Spotify,
  Flux, TTS, channel-reaction, TikTok-boost, song, and group-status commands.
- The WhatsApp client is pinned to the published
  `@whiskeysockets/baileys` 7.0.0-rc14 package.
- The project is ESM already; its runtime requirement is now declared as
  Node.js 20 or newer, as required by Baileys 7.
- Updated owner/admin and contact matching to preserve WhatsApp's v7 LID and
  phone-number alternate identifiers. Direct-message auto-typing now accepts
  `@lid` chats as well.
- Baileys 7's multi-file auth helper supports its new LID/device-list/token
  auth keys. Back up `auth_info/` before the first launch with v7.
- `!music` and `!song` send the `X-API-Key` header to David Cyril's `/play` and
  `/song` endpoints. `!ai` and chatbot replies use David's GPT-5 and Claude
  Sonnet 4.6 before the existing David/EliteProtech fallbacks; `!soundcloud`
  searches and returns up to five selectable SoundCloud track links.
- Set `DAVID_API_KEY` in the host's secret/environment settings for those
  providers. The real key is intentionally not stored in this source archive.
- `!flux` now authenticates with `DAVID_API_KEY`; added `!animate` through
  David Cyril's `/animagine` endpoint. `!imgine` is an alias that explicitly
  uses the Pollinations Flux image URL, while `!imagine` retains its configured
  provider behavior.
- Added TikWM's `https://tikwm.com/api/` as the final TikTok download fallback.
- Fixed auto-status handling so status updates are checked before empty-message
  filtering, and status updates arriving during history sync are handled too.
  Repeated status upserts are deduplicated within the active session.
  `!autostatus react ❤️ 🔥 😍` now saves three custom emoji and randomly applies
  one as a WhatsApp status reaction; `react on/off` toggles reactions.
- At startup, the client now fetches WhatsApp's current Web protocol version
  instead of always presenting a hard-coded version to WhatsApp.
- Incoming messages that arrive without a decrypted payload are now logged
  explicitly; five such failures in two minutes trigger one guarded socket
  recovery using the latest internal auth snapshot when available.
- Removed the optional newsletter/channel follow listener because the stable
  WhiskeySockets 6.7.24 socket does not expose `getNewsletterInfo`,
  `followNewsletter`, or `unfollowNewsletter`; unsupported optional APIs must
  not run during connection startup.
- `plogme@1.0.6` was reviewed but not adopted: it is another Crysnovax fork
  with an install-time identity gate and a separate protocol/runtime surface,
  so it is not a safer drop-in replacement for this production bot.
- TikTok downloads through David Cyril's V2, V4, and V3 compatibility
  providers.
- Direct-provider YouTube music downloads without the legacy YouTube metadata
  handshake.
- Anti-delete recovery for both `messages.delete` and revoke
  `messages.update` event formats.
- A shared assistant client used by both `!ai` and automatic chatbot replies.
- `!gemini` and the spelling-compatible `!gimini` commands. Text questions use
  the shared AI client; image creation works without a key; photo editing uses
  Google's Gemini image model when `GEMINI_API_KEY` is configured.
- Group-specific `!welcome on/off` settings, preserving the detailed welcome
  poster.
- `!antilink on` delete-only mode and `!antilink kick` warning/kick mode.
- Pairing cleanup after `/unpair` and WhatsApp logout so stale reconnect timers
  cannot recreate a deleted session.
- EliteProtech ChatGPT and NoteGPT are now the first AI providers, and their
  `text` response field is supported by both `!ai` and the automatic chatbot.
- Spotify link downloads continue to use the existing `spotifydl2` and
  `spotifydl` API fallback chain; `DAVID_API_KEY` is optional when the provider
  permits public access.
- `!mediafire` downloads MediaFire files, and `!telesticker` sends Telegram
  sticker packs from `t.me/addstickers/...` links.
- Facebook uses David Cyril's `facebook3` provider, and XNXX downloads use
  Botcahx's dedicated `xnxxdl` endpoint.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in the existing Telegram and owner settings.
3. Keep the TikTok URL as shown unless you want to override the first provider.
4. Optional: add `GEMINI_API_KEY` through the environment/secrets manager for
   prompt-based photo editing.
5. Use Node.js 20 or newer, install dependencies with `npm install`, then start
   with `npm start`.

The bot uses its existing persistent state file for live feature toggles.