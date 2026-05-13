# Linear Agent Skill

An installable agent skill for working with Linear issues, projects, initiatives, milestones, documents, comments, labels, cycles, and raw GraphQL.

The skill includes a bundled Node.js CLI that wraps `@linear/sdk` and gives agents a consistent `lt` command reference in `SKILL.md`.

## Install

Install from GitHub with the `skills` CLI:

```bash
npx skills add <owner>/linear-agent-skill --skill linear -a codex -g
```

You can also install directly from the skill directory URL:

```bash
npx skills add https://github.com/<owner>/linear-agent-skill/tree/main/skills/linear -a codex -g
```

Replace `codex` with another supported agent name if needed, or omit `-g` to install into the current project.

## Requirements

- Node.js 20+
- A Linear OAuth application or Linear API token

## Authentication

OAuth is recommended because actions are attributed to the app identity:

```bash
lt auth login --client-id <id> --client-secret <secret>
lt auth status
```

The callback URL for the Linear OAuth app can be `http://localhost`; any port is accepted.

You can also authenticate with an environment variable:

```bash
export LINEAR_ACCESS_TOKEN=<oauth-access-token>
# or
export LINEAR_API_KEY=<api-key>
```

OAuth credentials are stored at `~/.config/linear/credentials.toml`.

## Local Development

```bash
npm install
npm run build
npm run check
```

The source CLI lives in `src/linear.ts`. The installable skill uses the bundled executable at `skills/linear/bin/linear.mjs`.

## Security

This skill can read and write Linear data using your configured credentials. Review the code before installing from forks, and avoid committing API tokens or generated credential files.
