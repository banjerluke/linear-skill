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
- A Linear OAuth application client ID or Linear API token

## Authentication

OAuth with PKCE is the default. It needs only a client ID, and actions are attributed to the Linear user who authorizes access. Create a Linear OAuth application and configure its callback URL as `http://localhost:41549/callback`. A project-wide client ID can be shared by every local agent identity:

```toml
[oauth]
default_client_id = "<client-id>"
```

```bash
lt auth login --identity codex
lt auth login --identity claude
lt auth login --identity cursor
lt auth list
```

When `.linear.toml` contains identity-specific `[oauth.<identity>]` sections, `auth login --all` authenticates them sequentially. It prints the discovered configuration path, skips identities that already have usable credentials, and accepts `--force` to reauthorize every configured identity.

During normal commands, the CLI detects Codex, Claude Code, or Cursor Agent from runtime markers and selects that identity's credentials. For manual shells, nested agents, or other harnesses, pass `--identity <name>` or set `LINEAR_AGENT_IDENTITY`. Explicit selection always wins.

The same login command also works when the CLI is on a cloud or remote machine whose localhost callback cannot be reached by the user's browser. The CLI listens for a normal callback and simultaneously accepts a callback URL on stdin. Send the printed authorization URL to the user and ask them to authorize it. If the redirected localhost page fails to load, ask the user to copy the full URL from the browser address bar and paste it back, then write that URL to the waiting CLI process. The CLI validates the OAuth state and completes the PKCE token exchange on the remote machine. Do not ask the user for a Linear password, API key, or access token.

The client ID is public. The CLI generates a fresh PKCE verifier for login and stores only the resulting access and refresh tokens. User login defaults to `read` and `write`. Explicit `--scope` options replace that default set.

You can also authenticate with an environment variable:

```bash
export LINEAR_ACCESS_TOKEN=<oauth-access-token>
# or
export LINEAR_API_KEY=<api-key>
```

Identity-specific variables such as `CODEX_LINEAR_ACCESS_TOKEN` and `CLAUDE_LINEAR_ACCESS_TOKEN` are supported as fallbacks. A stored, refreshable identity profile takes precedence so an expired inherited token cannot shadow a completed PKCE login. Generic `LINEAR_ACCESS_TOKEN` and `LINEAR_API_KEY` remain explicit overrides.

OAuth credentials are stored by identity at `~/.config/linear/credentials.toml`. The file is written atomically with user-only permissions.

To use a distinct Linear app actor, enable client credentials and provide both its client ID and secret. Set `<IDENTITY>_LINEAR_OAUTH_CLIENT_SECRET` or configure `client_secret_command` under `[oauth.<identity>]`. Any normal command then mints and caches an app token automatically; no browser callback is needed. The secret is never stored in the credentials file. App mode uses the complete agent scope set. See [skills/linear/CONFIGURATION.md](skills/linear/CONFIGURATION.md) for the Bitwarden Secrets Manager example.

In short: a client ID alone uses user OAuth; a client ID plus a client secret uses app-mode client credentials. API keys also remain supported and act as their Linear user.

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
# Optional secret-manager command; Bitwarden returns the secret in JSON.value.
client_secret_command = ["bws", "secret", "get", "<bitwarden-secret-id>", "--output", "json"]
client_secret_field = "value"

[oauth.cursor]
client_id = "<cursor-client-id>"
```

Additional identities use the same `[oauth.<identity>]` shape. Client IDs, secret IDs, and secret commands may be committed; access tokens, refresh tokens, API keys, and client secrets must not be placed in `.linear.toml`.

OAuth client ID precedence is `--client-id`, identity-specific environment variable, identity-specific `.linear.toml`, generic environment variable, then project default. Login fails when none is configured; the CLI has no bundled or generic OAuth application fallback.

## Local Development

```bash
npm install
npm run build
npm run check
```

The source CLI lives in `src/linear.ts`. The installable skill uses the bundled executable at `skills/linear/bin/linear.mjs`.

## Security

This skill can read and write Linear data using your configured credentials. Review the code before installing from forks, and avoid committing API tokens or generated credential files.
