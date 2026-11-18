# agent-scout

Find the coding-agent CLIs on a computer, list the models each one can run,
and notice new models as they are released.

- **Find CLIs.** Claude Code, Codex, opencode, the Antigravity CLI (`agy`),
  OpenCode 2, Gemini, Devin, Grok, Cursor, Mistral Vibe, Pi, OMP, Kimi, Muse
  and Google's Antigravity ACP agent: whether each is installed, where, which
  version, and whether it is signed in.
- **List models.** Asked from each CLI's own records (`codex debug models`,
  `opencode models`, `agy models`, ...) and from published catalogs
  (models.dev, Anthropic's model page, a public Codex manifest), with effort
  levels and the default model.
- **Follow new models.** Each scan remembers what it saw, so the next one
  can say which models are new.

Zero dependencies: Node 22 or newer and its built-in modules only. No
`npm install` needed.

agent-scout was extracted from Helm,
where this code finds the agents a phone can start and fills their model
pickers. The Helm-only parts (accounts storage, sessions, terminals,
delegation, the phone app) are left out.

## Install

```sh
npm i github:HaseebUllahButt/agent-scout
```

or

```sh
git clone https://github.com/HaseebUllahButt/agent-scout
node agent-scout/bin/agent-scout.js scan
```

## Command line

```sh
agent-scout scan [--json] [--refresh] [--cli codex,claude]
agent-scout models <cli> [--json] [--refresh]
agent-scout new-models [--json] [--cli codex,claude]
agent-scout updates [--json] [--refresh] [--cli codex,claude]
```

| Option | What it does |
| --- | --- |
| `--json` | Print one JSON document to stdout and nothing else. |
| `--refresh` | Ask the CLIs again instead of using answers kept for 10 minutes. |
| `--cli <ids>` | Only these CLIs, comma separated. Aliases work (`agy`). |
| `--offline` | No network: skip the public catalogs. |
| `--state-dir <dir>` | Where to keep state (see below). |

Plain text is printed by default. `updates` shows each CLI's version, how it
was installed, and the command that would update it. agent-scout never runs
that command itself.

CLI ids: `claude`, `codex`, `opencode`, `antigravity` (alias `agy`),
`opencode2`, `gemini`, `devin`, `grok`, `cursor`, `vibe`, `pi`, `omp`, `kimi`,
`muse`, `antigravity-acp`.
