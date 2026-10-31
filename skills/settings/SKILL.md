---
name: settings
description: Configure whether Respire displays Memory, Used and prior-save hints. Saves the show or hide preference; recall and storage are unchanged.
---

Use this skill for Respire display preferences, not engine setup or memory maintenance.

1. Locate the bundled `../../lib/settings.js` relative to this SKILL.md. Run `node "<absolute script path>" status` and read its JSON. Do not guess an installed version, copy the script, or edit Codex config.toml. A `settings-invalid` result can be repaired with the user's explicit on/off choice; for unreadable files, report the error without changing permissions.
2. If the user already explicitly requested showing or hiding hints, use that choice. Otherwise show the current value and ask the user to choose **show memory status** or **hide memory status**. Do not change anything while waiting. Use a choice UI when available; a text answer is sufficient.
3. Run `node "<absolute script path>" on` or `off` for the chosen value. Check the exit code and returned JSON, then run `status` again to confirm it was persisted. If the operation fails, report the error and do not claim success.
4. Briefly confirm the saved value. It applies to subsequent user turns, including new chats, without restarting Codex. Existing text in chat is not removed.

The setting is stored in `CODEX_HOME/respire/settings.json` (normally `~/.codex/respire/settings.json`), outside the versioned plugin cache. It is shared across projects for that Codex profile and survives plugin upgrades. Users do not need to define an environment variable. Explicit saved preferences override the legacy `RESPIRE_MEMORY_STATUS` variable; without a saved preference, the old variable still works and the default is on.

This only controls Memory/Used/prior-save display hints. Do not disable the plugin or hooks, change trust or environment variables, start/stop the runtime, modify AGENTS.md, or read/write the memory library. Runtime failures and unconfirmed writes still report necessary diagnostics. This is a plugin skill workflow, not a native checkbox in Codex's plugin details page.
