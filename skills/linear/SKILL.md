---
name: linear
description: >
  This skill should be used when the user asks about Linear issues, projects,
  initiatives, milestones, documents, or any issue tracking tasks. Triggers on
  mentions of "Linear", issue identifiers like "SM-123", "create an issue",
  "update the issue", "list issues", "check project status", "add a comment",
  "search issues", or any issue/project management workflow.
license: MIT
---

# Linear API Tool

CLI tool wrapping `@linear/sdk` for Linear issue tracking.

**Requirements:** Node.js 20+. A custom Linear OAuth app client ID or Linear API token is optional because the skill includes a public OAuth fallback.

**IMPORTANT - Path Resolution:**
This skill can be installed in different locations. Before executing any commands, determine the skill directory based on where you loaded this SKILL.md file, and use that path in all commands below. Replace `$SKILL_DIR` with the actual discovered path.

**Invocation:** `$SKILL_DIR/bin/linear.mjs` (executable with shebang, no `node` prefix needed)

`lt` is used throughout this doc as shorthand for the full invocation path.

**Config:** Reads `.linear.toml` from CWD for `team_id` and OAuth client ID overrides. Auth from `~/.config/linear/credentials.toml`.

## Authentication

Supports two auth methods:

1. **OAuth with PKCE (recommended)** — No client secret is required. Actions are attributed to the selected app identity using `actor=app`.
2. **Env Token** — API keys act as the Linear user; OAuth access tokens retain the actor encoded at authorization. Set an identity-specific token such as `CODEX_LINEAR_ACCESS_TOKEN` or `CLAUDE_LINEAR_ACCESS_TOKEN`, or use the generic `LINEAR_ACCESS_TOKEN` / `LINEAR_API_KEY` fallback.
   - If `LINEAR_API_KEY` starts with `lin_oaut`, the tool treats it as an OAuth access token automatically.

The CLI keeps separate credential profiles for agent identities. It detects Codex, Claude Code, and Cursor Agent when their runtime markers are present. Pass `--identity <name>` or set `LINEAR_AGENT_IDENTITY` when running manually, nesting one agent inside another, or using another harness. Explicit identity selection always wins.

### OAuth Setup

Create one Linear OAuth application for each identity that should appear separately in Linear. For example, create `Codex`, `Claude Code`, and `Cursor` applications with their own names, icons, and client IDs.

1. Go to Linear Settings → API → OAuth Applications → New
2. Set the callback URL to `http://localhost:41549/callback`
3. Configure client IDs in `.linear.toml` or pass `--client-id` explicitly
4. Run `lt auth login --identity codex`, `lt auth login --identity claude`, and `lt auth login --identity cursor`
5. Open each printed URL and authorize the app installation
6. Tokens are saved by identity in `~/.config/linear/credentials.toml` with automatic refresh

```toml
[oauth.codex]
client_id = "<codex-client-id>"

[oauth.claude]
client_id = "<claude-client-id>"

[oauth.cursor]
client_id = "<cursor-client-id>"
```

Use `[oauth] default_client_id = "<id>"` as a project-level fallback for identities without their own section. The bundled neutral public OAuth app is the final fallback.

The client ID is public. PKCE protects the authorization-code exchange, so no client secret is supplied or stored. To make an app assignable or mentionable, add the corresponding scopes during login: `--scope read --scope write --scope app:assignable --scope app:mentionable`.

### Auth Commands

```
lt auth login --identity codex --client-id <id>
lt auth login --identity claude --client-id <id>
lt auth login --identity cursor --client-id <id>
lt auth status [--identity <name>]
lt auth list
lt auth logout [--identity <name>]
```

## Project Configuration

The complete `.linear.toml` schema is:

```toml
# Optional default for commands that accept --team.
team_id = "ENG"

[oauth]
default_client_id = "<project-default-client-id>"

[oauth.codex]
client_id = "<codex-client-id>"

[oauth.claude]
client_id = "<claude-client-id>"

[oauth.cursor]
client_id = "<cursor-client-id>"
```

Additional identities use `[oauth.<identity>]` with a `client_id`. Client IDs are public and may be committed. Never put access tokens, refresh tokens, API keys, or client secrets in `.linear.toml`.

Client ID precedence: `--client-id`, `<IDENTITY>_LINEAR_OAUTH_CLIENT_ID`, identity-specific `.linear.toml`, `LINEAR_OAUTH_CLIENT_ID`, `[oauth].default_client_id`, bundled public app.

## Output Format

- **Get commands** (issue, project, document, initiative, project-update, milestone) default to **markdown+frontmatter**:
  - YAML frontmatter with metadata (state flattened to name, parent flattened to identifier, dates shortened to YYYY-MM-DD)
  - Markdown body with description/content
  - Comments as nested `<comment>`/`<reply>` XML tags with author and date attributes
  - Use `--json` to get minified JSON instead
- **Simple get commands** (team, user, status, attachment) output minified JSON
- **List commands** return minified JSON array. If paginated: `{"nodes":[...],"pageInfo":{"endCursor":"..."}}`. `stripEmpty` omits null/empty fields.
- **Write commands** (create/update/delete) return minified JSON: `{"success":true,"identifier":"SM-123","url":"..."}`

## Identifier Resolution

The tool auto-resolves human-friendly references to UUIDs:

- Issues: `SM-123` -> UUID (via branch search)
- Teams: `SM` -> UUID (by key or name)
- Users: `me` -> current user; names/emails resolved by search
- Projects: by name (exact then fuzzy)
- States: by name (`In Progress`) or type (`started`, `backlog`, `unstarted`, `completed`, `canceled`)
- Labels: by name (case-insensitive)
- Cycles: `current`, `next`, `previous`, or cycle number
- Initiatives/Milestones: by name

Use `none` to clear nullable fields (assignee, project, parent).

## Quick Reference

### Issues

```
lt issue list [--team SM] [--assignee me] [--state started] [--project "Name"] [--label "Bug"] [--query "text"] [--parent SM-100] [--cycle current] [--created-after 2026-01-01] [--updated-after 2026-01-01] [--limit 50] [--cursor X] [--include-archived]
lt issue get SM-123 [--json] [--no-comments] [--include-relations]
lt issue create --title "Title" [--team SM] [--description "..."] [--state "Planned"] [--assignee me] [--priority 2] [--label "Bug"] [--label "UI"] [--project "Name"] [--parent SM-100] [--cycle current] [--milestone "M1"] [--estimate 3] [--due-date 2026-03-01]
lt issue update SM-123 [--title "New"] [--state "In Progress"] [--assignee me] [--priority 1] [--label "Bug"] [--add-label "UI"] [--remove-label "Old"] [--project "Name"] [--due-date 2026-03-01]
lt issue delete SM-123
lt issue search --query "search term" [--limit 20]
```

`issue search` does full-text search across all fields (title, description, comments). `issue list --query` filters by title only.

### Prefer Stdin for Markdown/Text Bodies

For comments, descriptions, document content, project updates, or any Markdown/text body beyond a tiny shell-safe phrase, prefer the explicit stdin variants. This avoids shell expansion and quoting bugs with Markdown, URLs, query strings, placeholders like `<email>`, and other shell-special characters.

```bash
lt issue create --title "Title" --description-stdin < description.md
lt issue update SM-123 --description-stdin < description.md
lt document create --title "Title" --content-stdin < content.md
lt document update <id> --content-stdin < content.md
lt comment create --issue SM-123 --body-stdin < comment.md
lt project-update create --project "Name" --body-stdin < update.md
```

Inline `--body "..."`, `--description "..."`, and `--content "..."` are okay only for short plain strings with no shell-special characters. When in doubt, use a single-quoted heredoc:

```bash
lt comment create --issue SM-123 --body-stdin <<'EOF'
Implemented the fix.

- `?devLogin=<email>` now switches users.
- Verification passed.
EOF
```

Supported stdin variants:

- `--description-stdin` for commands that accept `--description`
- `--content-stdin` for commands that accept `--content`
- `--body-stdin` for commands that accept `--body`

Use either the regular option or the stdin variant, not both. Only one `--*-stdin` option can be used per command.

### Hashline Read/Edit (surgical content editing)

Use `read` + `edit` for precise, line-level edits to issue descriptions and document content. Preferred over full replacement via `update --description` / `update --content`.

**Read** returns content with hashline anchors (`LINE#HASH:content`):

```
lt issue read SM-123 [--no-comments] [--section "Heading" | --lines 20:40 | --match "text" [--context 3]]
lt document read <id> [--section "Heading" | --lines 20:40 | --match "text" [--context 3]]
```

Example output:

```
---
identifier: SM-123
title: Migration plan
state: In Progress
---

 1#ZP:## Overview
 2#MQ:
 3#VR:Migrate billing to RevenueCat.
 4#KT:
 5#NW:## Tasks
 6#JB:- [ ] Create RC account
 7#TX:- [x] Configure Android
```

**Edit** reads edit commands from stdin. Use a heredoc:

```bash
lt issue edit SM-123 <<'EDITS'
replace 6#JB:- [x] Create RC account
EDITS

lt document edit <id> <<'EDITS'
replace 3#VR:Updated line
EDITS
```

Target large descriptions and documents instead of returning the full body:

```bash
lt issue read SM-123 --section "Implementation Plan" --no-comments
lt issue read SM-123 --lines 530:590 --no-comments
lt issue read SM-123 --match "promotion gate" --context 4 --no-comments
```

- `--section` matches a Markdown heading case-insensitively and returns that section through the next heading of the same or higher level.
- `--lines` accepts a 1-based line or inclusive range.
- `--match` performs a case-insensitive literal match and returns every match with two context lines by default.
- Targeted reads preserve the original line numbers and hashes, so their anchors work with `edit`.
- Use only one selector per read. `--context` is valid only with `--match`.

Edit commands (one per line, lowercase):

- `replace ANCHOR:content` — replace the anchored line (use heredoc for multi-line)
- `append ANCHOR:content` — insert after the anchored line
- `prepend ANCHOR:content` — insert before the anchored line
- `delete ANCHOR` — remove the anchored line (no `:` needed)

Multiple edits in one call:

```bash
lt issue edit SM-123 <<'EDITS'
replace 6#JB:- [x] Create RC account
append 7#TX:- [ ] Configure webhooks
EDITS
```

Multi-line replacement with heredoc (`:<<<` ... `>>>`):

```bash
lt issue edit SM-123 <<'EDITS'
replace 3#VR:<<<
RevenueCat handles all billing.
See docs for details.
>>>
EDITS
```

On success, `edit` outputs compact JSON. Pass `--print` to output the full refreshed hashline-anchored body when it is genuinely needed. When continuing after a compact edit, prefer another targeted `read`. On hash mismatch (content changed since read), `edit` fails with an error showing the current line content.

### Comments

```
lt comment list --issue SM-123
lt comment create --issue SM-123 --body "Comment text" [--parent <commentId>]
```

### Labels

```
lt label list [--team SM] [--name "Bug"] [--limit 50]
lt label create --name "New Label" [--team SM] [--color "#eb5757"] [--description "..."]
```

### Projects

```
lt project list [--status started] [--member me] [--query "Name"] [--initiative "Init"] [--limit 50]
lt project get "Project Name" [--json] [--include-milestones]
lt project create --name "Name" --team SM [--description "..."] [--lead me] [--priority 2] [--start-date 2026-01-01] [--target-date 2026-06-01] [--state planned]
lt project update "Name" [--name "New"] [--description "..."] [--lead me] [--state started]
```

### Project Updates

```
lt project-update list [--project "Name"]
lt project-update get <id> [--json]
lt project-update create --project "Name" --body "Update text" [--health onTrack|atRisk|offTrack]
lt project-update update <id> [--body "New"] [--health atRisk]
```

### Documents

```
lt document list [--project "Name"] [--query "text"] [--initiative "Init"]
lt document get <id> [--json]
lt document create --title "Title" [--project "Name"] [--content "Markdown..."] [--icon "emoji"]
lt document update <id> [--title "New"] [--content "Updated..."]
lt document read <id> [--section "Heading" | --lines 20:40 | --match "text" [--context 3]]
echo "replace 3#VR:new text" | lt document edit <id>
```

Document `read`/`edit` works identically to issue `read`/`edit` — see Hashline Read/Edit section above.

### Initiatives

```
lt initiative list [--status active] [--query "Name"]
lt initiative get "Name" [--json] [--include-projects]
lt initiative create --name "Name" [--description "..."] [--status planned|active|completed] [--owner me] [--target-date 2026-12-31]
lt initiative update "Name" [--status active] [--owner me]
```

### Initiative Updates

```
lt initiative-update list [--initiative "Name"]
lt initiative-update create --initiative "Name" --body "Update text" [--health onTrack|atRisk|offTrack]
lt initiative-update update <id> [--body "New"] [--health atRisk]
lt initiative-update delete <id>
```

### Milestones

```
lt milestone list --project "Name"
lt milestone get "Milestone Name" [--json] [--project "Name"]
lt milestone create --project "Name" --name "M1" [--description "..."] [--target-date 2026-03-01]
lt milestone update "M1" [--project "Name"] [--name "New"] [--target-date 2026-04-01]
```

### Teams, Users, Cycles, States

```
lt team list [--query "Name"]
lt team get SM
lt user list [--query "Name"]
lt user get me
lt cycle list --team SM [--type current|next|previous]
lt status list --team SM
lt status get "In Progress" --team SM
```

### Attachments

```
lt attachment get <id>
lt attachment create --issue SM-123 --url "https://..." --title "Link title" [--subtitle "..."]
lt attachment delete <id>
```

### Issue Relations

```
lt relation create --issue SM-123 --related SM-456 --type blocks|related|duplicate
lt relation delete <relation-id>
```

### Raw GraphQL (escape hatch)

```
lt graphql query --query '{ viewer { id name } }' [--variables '{"key":"value"}']
```

## Notes

- `lt` = `$SKILL_DIR/bin/linear.mjs`
- Identity selection precedence: `--identity`, `LINEAR_AGENT_IDENTITY`, then conservative Codex/Claude Code/Cursor detection
- Auth precedence: generic `LINEAR_ACCESS_TOKEN` / `LINEAR_API_KEY` overrides, refreshable identity profile, identity-specific env fallback
- Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low
- `issue get` and `issue read` include comments by default; use `--no-comments` to suppress
- Project states: `planned`, `started`, `paused`, `completed`, `canceled`, `backlog`
- Initiative statuses: `planned`, `active`, `completed`, `paused`
- Health values: `onTrack`, `atRisk`, `offTrack`
- All list commands support `--limit N` (default 50) and `--cursor X` for pagination
- `--team` defaults to `team_id` from `.linear.toml` when available
- Errors output JSON to stderr: `{"error":"message"}`
- **Linear Markdown normalization:** Linear wraps URLs in angle brackets on save — `[text](url)` becomes `[text](<url>)`. Always pre-wrap URLs when writing Markdown links: `[text](<url>)`. This prevents content from changing after save, which would invalidate hashline anchors.

## Issue Workflow

- **Starting work**: `lt issue update SM-123 --state "In Progress"`
- **Code complete**: Do NOT mark as "Done" yet. Wait for user confirmation.
- **User confirms**: `lt issue update SM-123 --state "Done"` + `lt comment create --issue SM-123 --body "Done: [what was done]"`
