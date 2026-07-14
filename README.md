# Linear Skill

An installable agent skill for working with Linear issues, projects, initiatives, milestones, documents, comments, labels, cycles, and raw GraphQL.

The skill includes a bundled Node.js CLI that wraps `@linear/sdk` and gives agents a consistent `lt` command reference in `SKILL.md`.

## Install

Install from GitHub with the `skills` CLI:

```bash
npx skills add <owner>/linear-skill --skill linear -a codex -g
```

You can also install directly from the skill directory URL:

```bash
npx skills add https://github.com/<owner>/linear-skill/tree/main/skills/linear -a codex -g
```

Replace `codex` with another supported agent name if needed, or omit `-g` to install into the current project.

## Requirements

- Node.js 20+
- Optional: a custom Linear OAuth application client ID or Linear API token

## Authentication

OAuth with PKCE is recommended because it needs no client secret and actions are attributed to the app identity. Create a separate Linear OAuth application for every identity that should appear independently in Linear, such as Codex, Claude Code, and Cursor. Configure each callback URL as `http://localhost:41549/callback`.

```toml
[oauth.codex]
client_id = "<codex-client-id>"

[oauth.claude]
client_id = "<claude-client-id>"

[oauth.cursor]
client_id = "<cursor-client-id>"
```

```bash
lt auth login --identity codex
lt auth login --identity claude
lt auth login --identity cursor
lt auth list
```

During normal commands, the CLI detects Codex, Claude Code, or Cursor Agent from runtime markers and selects that identity's credentials. For manual shells, nested agents, or other harnesses, pass `--identity <name>` or set `LINEAR_AGENT_IDENTITY`. Explicit selection always wins.

The same login command also works when the CLI is on a cloud or remote machine whose localhost callback cannot be reached by the user's browser. The CLI listens for a normal callback and simultaneously accepts a callback URL on stdin. Send the printed authorization URL to the user and ask them to authorize it. If the redirected localhost page fails to load, ask the user to copy the full URL from the browser address bar and paste it back, then write that URL to the waiting CLI process. The CLI validates the OAuth state and completes the PKCE token exchange on the remote machine. Do not ask the user for a Linear password, API key, or access token.

The client ID is public. The CLI generates a fresh PKCE verifier for login and stores only the resulting access and refresh tokens. To make the identity assignable or mentionable, log in with `--scope read --scope write --scope app:assignable --scope app:mentionable`.

You can also authenticate with an environment variable:

```bash
export LINEAR_ACCESS_TOKEN=<oauth-access-token>
# or
export LINEAR_API_KEY=<api-key>
```

Identity-specific variables such as `CODEX_LINEAR_ACCESS_TOKEN` and `CLAUDE_LINEAR_ACCESS_TOKEN` are supported as fallbacks. A stored, refreshable identity profile takes precedence so an expired inherited token cannot shadow a completed PKCE login. Generic `LINEAR_ACCESS_TOKEN` and `LINEAR_API_KEY` remain explicit overrides.

OAuth credentials are stored by identity at `~/.config/linear/credentials.toml`. The file is written atomically with user-only permissions.

API keys remain supported for users who want actions attributed to their own Linear account. OAuth logins use `actor=app` and are attributed to the selected application identity.

## Project Configuration

The complete `.linear.toml` schema is:

```toml
# Optional default for commands that accept --team.
team_id = "ENG"

# Optional project fallback for identities without a dedicated OAuth app.
[oauth]
default_client_id = "<project-default-client-id>"

# Optional identity-specific public OAuth client IDs.
[oauth.codex]
client_id = "<codex-client-id>"

[oauth.claude]
client_id = "<claude-client-id>"

[oauth.cursor]
client_id = "<cursor-client-id>"
```

Additional identities use the same `[oauth.<identity>]` shape. Client IDs are public and may be committed; access tokens, refresh tokens, API keys, and client secrets must not be placed in `.linear.toml`.

OAuth client ID precedence is `--client-id`, identity-specific environment variable, identity-specific `.linear.toml`, generic environment variable, project default, then the bundled public app.

## Local Development

```bash
npm install
npm run build
npm run check
```

The source CLI lives in `src/linear.ts`. The installable skill uses the bundled executable at `skills/linear/bin/linear.mjs`.

## Security

This skill can read and write Linear data using your configured credentials. Review the code before installing from forks, and avoid committing API tokens or generated credential files.
