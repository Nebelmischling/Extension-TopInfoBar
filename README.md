# Chat Top Info Bar (fork)

Adds a top bar to the chat window with shortcuts to quick actions (left to right):

- Open a sidebar with a chats list
- Open connection profiles
- View chat file name and switch chats
- Search in the chat
- View the chat file manager
- Create a new chat
- Rename the current chat
- Delete the current chat
- Close the current chat

This is a fork of [SillyTavern/Extension-TopInfoBar](https://github.com/SillyTavern/Extension-TopInfoBar),
kept compatible with current SillyTavern releases. Licensed AGPL-3.0, same as upstream.

## Compatibility

- Tested against **SillyTavern 1.19.0** (release branch, 2026-09-14).
- Requires a SillyTavern build that provides the module layout under
  `public/scripts/` (any 2024+ release; the extension imports `script.js`,
  `scripts/utils.js`, `scripts/constants.js`, `scripts/i18n.js` and
  `scripts/group-chats.js` directly).
- The built-in *Connection Profiles* extension should stay enabled for the
  connection profile panel to be fully functional. If the selector is missing,
  the panel degrades gracefully instead of throwing.

## Changes in 1.2.0

- **Generation preset dropdown**: the connection profiles panel now also shows the
  generation preset of the active API (chat completion, text completion, Kobold,
  KoboldHorde, NovelAI). It mirrors SillyTavern's own preset select, follows API
  and connection profile switches, and switching a preset in the top bar applies
  it in SillyTavern immediately.

## Changes in 1.1.0

- **Current SillyTavern compatibility**: verified imports, DOM ids, event types
  and popup API against ST 1.19.0; `popup` results are now compared with
  `POPUP_RESULT.AFFIRMATIVE`, `waitUntilCondition` no longer produces unhandled
  rejections when a helper extension renders late, and the decorative API icon
  uses `SillyTavern.libs.SVGInject` (with a `window.SVGInject` fallback).
- **Fixed chat search highlighting** (upstream issue #4): the old jQuery highlight
  plugin split the query on word boundaries, created empty regex alternatives and
  only highlighted the first match of each text node. `highlight.js` is a native,
  dependency-free replacement that highlights every match and never touches
  surrounding markup.
- **Close chat works for cardless/temporary chats** (upstream issue #7): the
  button now runs the `/closechat` slash command, the same code path SillyTavern
  itself uses.
- **Chat manager and delete chat** use the official `/chat-manager` and `/delchat`
  slash commands instead of clicking hidden menu entries.
- **Responsive top bar** (based on upstream PR #13): the bar keeps a single,
  horizontally scrollable row on phones, gestures no longer leak into chat swipe
  handlers, and space is reserved automatically for themes that pin the bar with
  `position: fixed`.
- **Robustness**: null-guarded DOM access, guarded slash-command calls, tolerant
  panel state parsing, sidebar no longer crashes when no chat is selected, and the
  sidebar loader is actually visible while chats are fetched.
- **Accessibility**: toolbar buttons are keyboard operable (Enter/Space) and have
  `aria-label`s.
- **German localization** (`i18n/de-de.json`).

## How to install

Use this URL with the SillyTavern extension installer:

```
https://github.com/Nebelmischling/Extension-TopInfoBar
```

Or clone it into `public/scripts/extensions/third-party/Extension-TopInfoBar` and
reload SillyTavern.

## Verification

Checked against SillyTavern 1.19.0 (release branch, commit `06bde93`, 2026-09-14):

- `node scripts/check-st-compat.mjs <ST-checkout>` → no incompatibilities
  (imports/exports, DOM ids, event types, CSS variables, manifest/i18n).
- Headless browser smoke test against a real SillyTavern instance: the extension
  loads, `#extensionTopBar` renders on desktop and on a 390x844 mobile viewport
  without overflow, all seven buttons are present, the sidebar toggle opens and
  lists the past chats, and there are zero console errors/warnings, uncaught
  exceptions or failed requests caused by the extension.
- `highlight.js` is additionally unit-tested against a jsdom DOM (multi-word
  queries, multiple matches per text node, regex metacharacters, umlauts,
  idempotent re-highlighting, markup preservation).

## Development

The extension is plain JavaScript/CSS without a build step.

```bash
# Syntax check
node --check index.js
node --check highlight.js

# Verify the extension against a local SillyTavern checkout
node scripts/check-st-compat.mjs "C:/path/to/SillyTavern"
```

`scripts/check-st-compat.mjs` verifies that every module the extension imports
still exists in the given SillyTavern checkout, that the imported symbols are
still exported, that the DOM ids and event types the extension relies on are
still present, and that the manifest/i18n files are valid. Run it after updating
SillyTavern; it exits non-zero when something breaks.

## License

AGPLv3 - see [LICENSE](LICENSE).
