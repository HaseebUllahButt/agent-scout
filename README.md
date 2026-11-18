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

## The `scan --json` shape

```json
{
  "scannedAt": "2026-11-18T17:00:00.000Z",
  "clis": [
    {
      "id": "codex",
      "label": "Codex",
      "aliases": [],
      "installed": true,
      "path": "/usr/local/bin/codex",
      "realPath": "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
      "onPath": true,
      "version": "0.170.0",
      "home": "/home/user/.codex",
      "signedIn": true,
      "defaultModel": "gpt-6.2-sol",
      "defaultEffort": "high",
      "models": [
        {
          "id": "gpt-6.2-sol",
          "label": "GPT-6.2-Sol",
          "default": true,
          "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
          "defaultEffort": "high",
          "images": true,
          "new": false
        }
      ],
      "modelSource": "codex debug models",
      "error": null
    }
  ],
  "newModels": [
    { "cli": "codex", "id": "gpt-6.3-sol", "label": "GPT-6.3-Sol", "successor": true }
  ]
}
```

- Every known CLI is listed. A CLI that is not installed has
  `installed: false`, `path: null` and empty `models`.
- `signedIn` is `true`, `false`, or `null` when the CLI cannot say. Claude
  Code, Codex and the Antigravity CLI can say; the rest are `null`.
- `models[].efforts` are the effort levels that model takes (empty when it
  has none or the CLI does not say). `defaultEffort` is the level a chat
  starts with: the account's saved level when the model takes it, otherwise
  the model's own starting level when the CLI says.
- `models[].new` is `true` for a model that was not there at the last scan.
- `modelSource` names where the list came from, for example
  `codex debug models`, `Claude config + models.dev + Anthropic models page`,
  `opencode models`, `agy models`.
- `error` explains an empty model list (`signed out`, `no models found`, or
  the CLI's own error). It is `null` when models were found.
- opencode: when a saved key is refused by the service, its provider is in
  `signedOutProviders`, its models go last with `signedOut: true`, and the
  default moves to a model that works.
- `newModels[].successor` is `true` when the model is a newer version of a
  line the account already had (`claude-opus-5-6` after `claude-opus-5-5`),
  and `false` for anything else new (an old model that only now showed up, a
  new provider's models, a name without a readable version).

`agent-scout models <cli> --json` prints one CLI's
`{ cli, label, installed, path, defaultModel, defaultEffort, models, modelSource, error }`.
`agent-scout new-models --json` prints `{ checkedAt, newModels }`.
