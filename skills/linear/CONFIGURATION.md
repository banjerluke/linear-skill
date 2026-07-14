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
client_secret_command = ["bws", "secret", "get", "<bitwarden-secret-id>", "--output", "json"]
client_secret_field = "value"

[oauth.cursor]
client_id = "<cursor-client-id>"
```

Additional identities use `[oauth.<identity>]` with a `client_id`. Client IDs, secret IDs, and secret commands may be committed. Never put access tokens, refresh tokens, API keys, or client secrets in `.linear.toml`.

Client credentials secrets must come from the environment or a secret manager:

```bash
export CODEX_LINEAR_OAUTH_CLIENT_SECRET="<codex-secret>"
export CLAUDE_LINEAR_OAUTH_CLIENT_SECRET="<claude-secret>"
export CURSOR_LINEAR_OAUTH_CLIENT_SECRET="<cursor-secret>"
```

For Bitwarden Secrets Manager, authenticate `bws` with a narrowly scoped machine account and set `BWS_ACCESS_TOKEN` in the machine environment. `bws secret get` returns JSON, so `client_secret_field = "value"` selects the secret value. Other secret commands may omit `client_secret_field` when they print only the secret.

The CLI executes `client_secret_command` directly as the configured argument array, never through a shell. It trims the result, does not log it, and invokes the command only when it must mint or renew a Linear token. Identity-specific environment secrets take precedence over the configured command; the generic `LINEAR_OAUTH_CLIENT_SECRET` is the final fallback. A client ID without a secret uses user OAuth with PKCE. When both a secret provider and client ID are configured, the CLI switches to app-mode client credentials and any normal command authenticates automatically; `auth login` is not required.

OAuth client ID precedence is `--client-id`, `<IDENTITY>_LINEAR_OAUTH_CLIENT_ID`, identity-specific `.linear.toml`, `LINEAR_OAUTH_CLIENT_ID`, then `[oauth].default_client_id`. Client secret precedence is `<IDENTITY>_LINEAR_OAUTH_CLIENT_SECRET`, identity-specific `client_secret_command`, then `LINEAR_OAUTH_CLIENT_SECRET`. There is no bundled OAuth application fallback.

Commands that accept `--team` default to `team_id` when it is configured.
