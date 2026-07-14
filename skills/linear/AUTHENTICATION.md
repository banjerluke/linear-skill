# Linear Authentication

Read this reference before running authentication commands, configuring OAuth, or diagnosing credentials. `lt` means the `$SKILL_DIR/bin/linear.mjs` executable defined in `SKILL.md`.

## Authentication Methods

The CLI supports three authentication methods:

1. **OAuth with PKCE (default)** - A configured client ID without a client secret authorizes the Linear user. Actions are attributed to that user, and the CLI refreshes the credential automatically.
2. **Client credentials (app mode)** - When both a client ID and client secret are available, normal commands automatically mint and cache an app token. No login command or browser callback is needed.
3. **Environment token** - API keys act as the Linear user; OAuth access tokens retain the actor encoded at authorization. Set an identity-specific token such as `CODEX_LINEAR_ACCESS_TOKEN` or `CLAUDE_LINEAR_ACCESS_TOKEN`, or use the generic `LINEAR_ACCESS_TOKEN` / `LINEAR_API_KEY` fallback.
   - If `LINEAR_API_KEY` starts with `lin_oaut`, the tool treats it as an OAuth access token automatically.

The CLI keeps separate credential profiles for agent identities. It detects Codex, Claude Code, and Cursor Agent when their runtime markers are present. Pass `--identity <name>` or set `LINEAR_AGENT_IDENTITY` when running manually, nesting one agent inside another, or using another harness. Explicit identity selection always wins.

The local identity selects a credential profile; it does not rename the Linear OAuth application. User-mode actions always appear as the authorizing Linear user. To have actions appear as Codex, Claude Code, or another distinct app, configure that app's client ID and client secret for the identity. Login fails when no client ID is configured. There is no bundled or generic OAuth application fallback.

Identity selection precedence: `--identity`, `LINEAR_AGENT_IDENTITY`, then conservative Codex/Claude Code/Cursor detection.

Authentication precedence: generic `LINEAR_ACCESS_TOKEN` / `LINEAR_API_KEY` overrides, stored identity profile, identity-specific environment token, automatic client credentials, then legacy credentials. When a client secret is newly configured, it replaces a stored authorization-code profile on the next normal command.

## Automatic Client Credentials

Use client credentials when a distinct app identity must work on multiple computers or cloud workers.

1. Enable the client credentials grant in the private Linear OAuth application.
2. Keep its public client ID in `.linear.toml` under `[oauth.<identity>]`, or set `<IDENTITY>_LINEAR_OAUTH_CLIENT_ID`.
3. Provide the client secret as `<IDENTITY>_LINEAR_OAUTH_CLIENT_SECRET`, or configure an identity-specific `client_secret_command` that retrieves it from a secret manager.
4. Run any normal `lt` command. Do not run `auth login`.

For example:

```bash
export CLAUDE_LINEAR_OAUTH_CLIENT_SECRET="<secret>"
lt issue list --team ENG
```

With Bitwarden Secrets Manager:

```toml
[oauth.claude]
client_id = "<claude-client-id>"
client_secret_command = ["bws", "secret", "get", "<bitwarden-secret-id>", "--output", "json"]
client_secret_field = "value"
```

Set `BWS_ACCESS_TOKEN` for a machine account that can read that secret, then run the same normal `lt` command. The command is executed directly without a shell and only when a token must be minted or renewed. See [CONFIGURATION.md](CONFIGURATION.md) for precedence and command output rules.

On the first command, the CLI requests an app-actor token with the canonical agent scopes, stores only the token and its expiry in `~/.config/linear/credentials.toml`, and continues the command. The client secret is never written to disk or printed. Subsequent commands reuse the cached token. Within five minutes of expiry, the CLI automatically obtains and stores a replacement token using the configured secret provider.

`LINEAR_OAUTH_CLIENT_SECRET` is supported as a generic fallback, but identity-specific secrets are safer when multiple apps share a machine. All machines using one app must request the same canonical scope set or Linear may revoke the other client-credentials tokens.

## User OAuth Setup

Create a Linear OAuth application for user authorization. Because mutations are attributed to the authorizing user, Codex, Claude Code, and Cursor may share one project-wide client ID.

1. Go to Linear Settings -> API -> OAuth Applications -> New.
2. Set the callback URL to `http://localhost:41549/callback`.
3. Configure the client ID in `.linear.toml` or pass `--client-id` explicitly. Do not configure a client secret for user mode. See [CONFIGURATION.md](CONFIGURATION.md).
4. Run `lt auth login --identity codex`, `lt auth login --identity claude`, and `lt auth login --identity cursor`.
5. Open each printed URL and authorize access as your Linear user.
6. Tokens are saved by identity in `~/.config/linear/credentials.toml` with automatic refresh.

The client ID is public. PKCE protects the authorization-code exchange, so no client secret is supplied or stored.

By default, user login requests `read` and `write`. Passing one or more explicit `--scope` options replaces this default set.

## Login

Run `lt auth login --help` for the current command options and agent workflow.

1. Start `lt auth login --identity <name>` in a long-lived interactive process.
2. Relay the printed Linear authorization URL to the user and ask them to authorize the app.
3. Keep the process alive until the callback completes.
4. Run `lt auth status --identity <name>` after login.

To authenticate every identity-specific OAuth configuration in the discovered `.linear.toml`, run `lt auth login --all`. The CLI prints the configuration path, skips identities with usable stored credentials, identity-specific environment tokens, or automatic client credentials, and processes the remaining identities sequentially. Use `--force` to reauthorize all configured identities. Generic `LINEAR_ACCESS_TOKEN` and `LINEAR_API_KEY` values do not cause identities to be skipped because they are not identity-specific; the CLI warns that they will override stored profiles during normal commands.

`--all` cannot be combined with `--identity` or `--client-id`. It requires at least one `[oauth.<identity>]` section in `.linear.toml`.

The CLI listens for the HTTP callback and accepts a pasted callback URL at the same time. If the CLI runs on a cloud machine, container, or remote host that the user's browser cannot reach at localhost:

1. Ask the user to authorize using the printed URL.
2. The browser redirects to `http://localhost:41549/callback` and may show a connection error.
3. Ask the user to return the full URL from the browser address bar. Do not ask for their password, API key, or access token.
4. Write the callback URL to the waiting CLI process. Its PKCE verifier exists only in that process.

The authorization code is single-use. The CLI verifies the callback origin, path, and OAuth state before exchanging it.

Login sends `prompt=consent` so Linear displays the user consent screen every time. App installations are created only through client credentials mode, when the CLI has both the application client ID and secret.

## Commands

```text
lt auth login --identity codex --client-id <id>
lt auth login --identity claude --client-id <id>
lt auth login --identity cursor --client-id <id>
lt auth login --all
lt auth login --all --force
lt auth status [--identity <name>]
lt auth list
lt auth logout [--identity <name>]
```
