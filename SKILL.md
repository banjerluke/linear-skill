---
name: linear
description: >
  This skill should be used when the user asks about Linear issues, projects,
  initiatives, milestones, documents, or any issue tracking tasks. Triggers on
  mentions of "Linear", issue identifiers like "SM-123", "create an issue",
  "update the issue", "list issues", "check project status", "add a comment",
  "search issues", or any issue/project management workflow. Also use when
  the user references beads/bd tasks that need syncing to Linear.
---

# Linear API Tool

CLI tool wrapping `@linear/sdk` for Linear issue tracking.

**Invocation:** `~/.claude/skills/linear/linear.ts` (executable with shebang, no `node` prefix needed)

**Config:** Reads `.linear.toml` from CWD for defaults (`team_id`, `workspace`). Auth from `~/.config/linear/credentials.toml`.

## Authentication

Supports two auth methods:

1. **OAuth (recommended)** — Actions attributed to the app, not your personal account. Uses `actor=app` for a separate agent identity.
2. **Env Token** — Set `LINEAR_ACCESS_TOKEN` (OAuth access token) or `LINEAR_API_KEY` (API token).
   - If `LINEAR_API_KEY` starts with `lin_oaut`, the tool treats it as an OAuth access token automatically.

### OAuth Setup
1. Go to Linear Settings → API → OAuth Applications → New
2. Set callback URL to `http://localhost` (any port is accepted)
3. Run: `lt auth login --client-id <id> --client-secret <secret>`
4. Open the printed URL in your browser and authorize
5. Tokens are saved to `~/.config/linear/credentials.toml` with automatic refresh

### Auth Commands
```
lt auth login --client-id <id> --client-secret <secret>
lt auth status
```

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
lt issue get SM-123 [--json] [--include-comments] [--include-relations]
lt issue create --title "Title" [--team SM] [--description "..."] [--state "Planned"] [--assignee me] [--priority 2] [--label "Bug"] [--label "UI"] [--project "Name"] [--parent SM-100] [--cycle current] [--milestone "M1"] [--estimate 3] [--due-date 2026-03-01]
lt issue update SM-123 [--title "New"] [--state "In Progress"] [--assignee me] [--priority 1] [--label "Bug"] [--add-label "UI"] [--remove-label "Old"] [--project "Name"] [--due-date 2026-03-01]
lt issue delete SM-123
lt issue search --query "search term" [--limit 20]
```

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
```

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

- `lt` = `~/.claude/skills/linear/linear.ts`
- Env auth precedence: `LINEAR_ACCESS_TOKEN` first, then `LINEAR_API_KEY`
- Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low
- Project states: `planned`, `started`, `paused`, `completed`, `canceled`, `backlog`
- Initiative statuses: `planned`, `active`, `completed`, `paused`
- Health values: `onTrack`, `atRisk`, `offTrack`
- All list commands support `--limit N` (default 50) and `--cursor X` for pagination
- `--team` defaults to `team_id` from `.linear.toml` when available
- Errors output JSON to stderr: `{"error":"message"}`

## Issue Workflow

- **Starting work**: `lt issue update SM-123 --state "In Progress"`
- **Code complete**: Do NOT mark as "Done" yet. Wait for user confirmation.
- **User confirms**: `lt issue update SM-123 --state "Done"` + `lt comment create --issue SM-123 --body "Done: [what was done]"`
