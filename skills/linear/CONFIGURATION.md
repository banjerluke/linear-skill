# Linear Configuration

Read this reference before creating or changing `.linear.toml`. The CLI searches for this file in the current working directory and then at the Git repository root.

## Schema

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

Additional identities use `[oauth.<identity>]` with a `client_id`. Client IDs are public and may be committed. Never put access tokens, refresh tokens, API keys, or client secrets in `.linear.toml`.

Client credentials secrets must come from the environment or a secret manager:

```bash
export CODEX_LINEAR_OAUTH_CLIENT_SECRET="<codex-secret>"
export CLAUDE_LINEAR_OAUTH_CLIENT_SECRET="<claude-secret>"
export CURSOR_LINEAR_OAUTH_CLIENT_SECRET="<cursor-secret>"
```

The generic `LINEAR_OAUTH_CLIENT_SECRET` is a fallback for the selected identity. An identity-specific secret takes precedence. When a secret and client ID are configured, any normal CLI command authenticates automatically; `auth login` is not required.

OAuth client ID precedence is `--client-id`, `<IDENTITY>_LINEAR_OAUTH_CLIENT_ID`, identity-specific `.linear.toml`, `LINEAR_OAUTH_CLIENT_ID`, then `[oauth].default_client_id`. The bundled generic app is selected only by the explicit `--use-generic-app` flag.

Commands that accept `--team` default to `team_id` when it is configured.
