---
name: shelf
description: Maintain the user's categorized snippet shelf and prompt templates. Use when the user asks to remember, harvest, look up, or turn a conversation into a reusable prompt.
---

# shelf

Global items live in `~/.pi/agent/pi-shelf/store.json`. Rules live in `config.json`. The current git repo uses `.pi/shelf.json`, identified by its remote. Prefer the `shelf` tool over editing those files. Delete archives an item; it is not erased.

- Search before adding, so you do not duplicate a URL.
- `add` / `update` / `delete` ask the user to confirm. Do not bypass that.
- To collect from the current session, call `harvest` with `topic` set to `github`, `doi`, `arxiv`, `url`, a custom topic id, or `all`. `harvest_github` is only the GitHub topic. The user confirms by count before anything is written.
- Add a custom topic with `/shelf topic` when the thing to collect is an id or pattern, such as `EMPIAR-\d+`.
- Dynamic sources are regenerated every pick. `/shelf pin` stores one as a permanent record.
- The tool does not insert into the editor. `/shelf` and `ctrl+shift+k` expand `{{variables}}` and then paste. Autocomplete pastes the template; `/shelf fill` expands variables already in the input.
- A prompt template uses `{{name}}`, `{{name:one|two}}`, or `{{name=default}}`. Pi's own `$1`, `${1:-default}`, and `$@` also expand. `/shelf prompt name args` fills positionals the way `/name args` does. Existing files in `~/.pi/agent/prompts` and `.pi/prompts` are selectable and are not copied until `/shelf pin`.
- If the user describes a prompt in natural language, write that template and `add` it under category `Prompt` after confirmation.
- If the user wants a template from this chat or earlier chats, call `prompt_context` first. It includes the current session and recent sessions for this project. Draft from that text, do not invent steps.
