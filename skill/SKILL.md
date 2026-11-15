---
name: shelf
description: Maintain the user's categorized snippet shelf and prompt templates. Use when the user asks to remember, harvest, look up, or turn a conversation into a reusable prompt.
---

# shelf

Global items live in `pi-shelf/store.json` under Pi's agent directory (`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`). Rules live in `config.json`. The current git repo uses `.pi/shelf.json`, identified by its remote. Prefer the `shelf` tool over editing those files. Delete archives an item; it is not erased.

- Search before adding, so you do not duplicate a URL.
- `add` / `update` / `delete` ask the user to confirm. Do not bypass that.
- To collect from the current session, call `harvest` with `topic` set to `github`, `doi`, `arxiv`, `url`, a custom topic id, or `all`. `harvest_github` is only the GitHub topic. The user confirms by count before anything is written.
- Add a custom topic with `/shelf topic` when the thing to collect is an id or pattern, such as `EMPIAR-\d+`.
- Dynamic sources are regenerated every pick. `/shelf pin` stores one as a permanent record.
- `/shelf ref add <url|owner/repo> [--alias rel] [--description "..."]` stores exact targets (GitHub canonicalized to https://github.com/owner/repo, DOI to doi.org, arXiv to /abs/id); `/shelf ref <fuzzy>` inserts the exact URL, asking the user to pick when several match; choices show the description. `/shelf ref describe-all` refreshes every Ref description (use --missing to fill only empty ones); `shelf ref_describe` fills a missing description (GitHub MCP -> GitHub API -> web_search summary). Prefer this over retyping a repository URL from memory.
- `/shelf alias` manages custom abbreviations (list/add/change/delete). They expand only on Tab, so short keys stay ordinary prose otherwise. Values may use `{{date}}`, `{{time}}`, `{{datetime}}`, `{{clipboard}}`, `{{clipboard-image}}`, `{{screenshot}}`, `{{env:NAME}}`, `{{random:a|b}}`, `{{uuid}}` and `{{cursor}}`; unknown text macros stay literal. Image macros insert a temp file path, not base64.
- Script aliases are a separate explicit type: purpose -> model-generated script -> user review -> execute on selection; stdout is inserted. Do not silently turn a text alias into executable code.
- `/shelf value` defines a named command whose stdout lines become candidates for `{{name=@id}}` slots. Never put a command inline in a template; reference a provider instead.
- A project `.pi/shelf.json` is approved by SHA-256 on first sight. If it changes, project sources and providers stay off until `/shelf trust` confirms the new hash; do not tell the user the commands ran when they were suspended.
- `/shelf enrich` fills a link's title/tags from GitHub, DOI, arXiv or the page title. `/shelf check` writes a dead-link report to diagnostics.json; 401/403/429 are "unknown", not dead.
- Multiple rows can be marked with Tab and inserted together; `placement` (prepend/append) and `order` decide the order, and the composed text is shown for editing first.
- A message containing `;name` expands to that entry's value when the title is unique. Do not use this to inject text the user did not ask for.
- Tool names complete from Pi's live registry (built-in, extension and connected MCP tools); never hardcode a tool list. A token containing "_" or starting with "pi-" opens the list on its own, other tokens need Tab. Plugin packages are derived from the extension source; a plugin row lists its tools and inserts the package name.
- `/shelf doctor` prints one line per storage/trust check. If a shelf file is not valid JSON it is shown as empty and is never overwritten until it is fixed or moved away; `/shelf import` and `/shelf export` move entries between machines without a service.
- The tool does not insert into the editor. `/shelf` and `ctrl+shift+k` expand `{{variables}}` and then paste. Autocomplete pastes the template; `/shelf fill` expands variables already in the input.
- A prompt template uses `{{name}}`, `{{name:one|two}}`, or `{{name=default}}`. Pi's own `$1`, `${1:-default}`, and `$@` expand only for prompt rows (category `Prompt`, a `prompts/*.md` file, or a `{{slot}}` template); an ordinary saved command keeps its `$1`/`$@` byte for byte. `/shelf prompt name args` fills positionals the way `/name args` does. Existing files in `~/.pi/agent/prompts` and `.pi/prompts` are selectable and are not copied until `/shelf pin`.
- If the user describes a prompt in natural language, write that template and `add` it under category `Prompt` after confirmation.
- If the user wants a template from this chat or earlier chats, call `prompt_context` first. It includes the current session and recent sessions for this project. Draft from that text, do not invent steps.
