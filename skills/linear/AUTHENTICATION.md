# Linear Authentication

Read this reference before running authentication commands, configuring OAuth, or diagnosing credentials. `lt` means the `$SKILL_DIR/bin/linear.mjs` executable defined in `SKILL.md`.

## Authentication Methods

The CLI supports two authentication methods:

1. **OAuth with PKCE (recommended)** - No client secret is required. Actions are attributed to the selected app identity using `actor=app`.
2. **Environment token** - API keys act as the Linear user; OAuth access tokens retain the actor encoded at authorization. Set an identity-specific token such as `CODEX_LINEAR_ACCESS_TOKEN` or `CLAUDE_LINEAR_ACCESS_TOKEN`, or use the generic `LINEAR_ACCESS_TOKEN` / `LINEAR_API_KEY` fallback.
   - If `LINEAR_API_KEY` starts with `lin_oaut`, the tool treats it as an OAuth access token automatically.

The CLI keeps separate credential profiles for agent identities. It detects Codex, Claude Code, and Cursor Agent when their runtime markers are present. Pass `--identity <name>` or set `LINEAR_AGENT_IDENTITY` when running manually, nesting one agent inside another, or using another harness. Explicit identity selection always wins.

The local identity selects a credential profile; it does not rename the Linear OAuth application. To have actions appear as Codex, Claude Code, or another distinct app, configure that app's client ID for the identity. Login fails when no client ID is configured instead of silently authorizing the bundled generic app. Use `--use-generic-app` only when the generic Linear app identity is intentional.

Identity selection precedence: `--identity`, `LINEAR_AGENT_IDENTITY`, then conservative Codex/Claude Code/Cursor detection.

Authentication precedence: generic `LINEAR_ACCESS_TOKEN` / `LINEAR_API_KEY` overrides, refreshable identity profile, then identity-specific environment fallback.

## OAuth Setup

Create one Linear OAuth application for each identity that should appear separately in Linear. For example, create `Codex`, `Claude Code`, and `Cursor` applications with their own names, icons, and client IDs.

1. Go to Linear Settings -> API -> OAuth Applications -> New.
2. Set the callback URL to `http://localhost:41549/callback`.
3. Configure client IDs in `.linear.toml` or pass `--client-id` explicitly. See [CONFIGURATION.md](CONFIGURATION.md).
4. Run `lt auth login --identity codex`, `lt auth login --identity claude`, and `lt auth login --identity cursor`.
5. Open each printed URL and authorize the app installation.
6. Tokens are saved by identity in `~/.config/linear/credentials.toml` with automatic refresh.

The client ID is public. PKCE protects the authorization-code exchange, so no client secret is supplied or stored.

By default, login requests the complete scope set used by a capable Linear agent: `read`, `write`, `app:assignable`, `app:mentionable`, `customer:read`, `customer:write`, `initiative:read`, and `initiative:write`. This prevents `prompt=consent` from unintentionally removing modern agent permissions from an existing installation. Passing one or more explicit `--scope` options replaces this default set and should be used only when a narrower installation is intentional.

## Login

Run `lt auth login --help` for the current command options and agent workflow.

1. Start `lt auth login --identity <name>` in a long-lived interactive process.
2. Relay the printed Linear authorization URL to the user and ask them to authorize the app.
3. Keep the process alive until the callback completes.
4. Run `lt auth status --identity <name>` after login.

To authenticate every identity-specific OAuth app in the discovered `.linear.toml`, run `lt auth login --all`. The CLI prints the configuration path, skips identities with usable stored or identity-specific environment credentials, and processes the remaining identities sequentially. Use `--force` to reauthorize all configured identities. Generic `LINEAR_ACCESS_TOKEN` and `LINEAR_API_KEY` values do not cause identities to be skipped because they are not identity-specific; the CLI warns that they will override stored profiles during normal commands.

`--all` cannot be combined with `--identity`, `--client-id`, or `--use-generic-app`. It requires at least one `[oauth.<identity>]` section in `.linear.toml`.

The CLI listens for the HTTP callback and accepts a pasted callback URL at the same time. If the CLI runs on a cloud machine, container, or remote host that the user's browser cannot reach at localhost:

1. Ask the user to authorize using the printed URL.
2. The browser redirects to `http://localhost:41549/callback` and may show a connection error.
3. Ask the user to return the full URL from the browser address bar. Do not ask for their password, API key, or access token.
4. Write the callback URL to the waiting CLI process. Its PKCE verifier exists only in that process.

The authorization code is single-use. The CLI verifies the callback origin, path, and OAuth state before exchanging it.

Login sends `prompt=consent` so Linear returns to the callback even when the app is already installed. Without it, Linear may show an "already installed" management screen instead of issuing a new authorization code.

## Commands

```text
lt auth login --identity codex --client-id <id>
lt auth login --identity claude --client-id <id>
lt auth login --identity cursor --client-id <id>
lt auth login --all
lt auth login --all --force
lt auth login --identity codex --use-generic-app
lt auth status [--identity <name>]
lt auth list
lt auth logout [--identity <name>]
```
