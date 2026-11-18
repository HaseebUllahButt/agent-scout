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

## Library

```js
import { scan, findClis, listModels, newModels } from 'agent-scout';

const result = await scan({ clis: ['claude', 'codex'] }); // same shape as scan --json
const clis = await findClis();                          // [{ id, label, installed, path, version, ... }]
const codex = await listModels('codex');                // { cli, defaultModel, models, modelSource, ... }
const fresh = await newModels();                        // [{ cli, id, label, successor }]
```

Options shared by these calls:

| Option | Meaning |
| --- | --- |
| `clis` | Ids to look at (array or `"codex,claude"`). Default: all. |
| `refresh` | Ignore the age of kept answers. They are still used if the CLI fails. |
| `offline` | No network calls. `AGENT_SCOUT_OFFLINE=1` does the same. |
| `fetch` | A replacement for the global `fetch` (tests, proxies). |
| `stateDir` | The state folder. |
| `cache` | `false` keeps model lists out of the state folder. |
| `env` | The environment to look in and run the CLIs with. |
| `homes` | `{ codex: '~/.codex-work' }`: read another account's home. |
| `path` | Search this PATH instead of asking the shells. |
| `shell` | `false` searches only `env.PATH` (or set `AGENT_SCOUT_NO_SHELL=1`). |
| `track` | `false` makes `scan` leave the "seen models" record alone. |
| `signin` | `false` skips the sign-in checks. |
| `concurrency` | How many CLIs `scan` asks at once (default 3). |

More is exported for callers that want the pieces: `checkSignedIn`,
`checkUpdates`, `findAccounts` (extra accounts from sibling homes such as
`~/.codex-work` and from shell aliases and wrapper scripts; secret values are
never reported), `optionArgs` (a CLI's own flags for model, effort and
"don't stop to ask"), the catalog parsers, and the follow helpers below.

## How CLIs are found

agent-scout asks one login shell where every CLI is (`command -v`), and one
interactive shell for its PATH, because many installers add their folder in
`~/.bashrc` only. Forwarding launchers that sit first on PATH (Helm puts one
per CLI in `~/.helm/bin`) are skipped, so `path` and `version` are the real
program's. `onPath: false` means the CLI is only reachable from the
terminal's PATH, so a caller should start it by its full path. Rc files can
check `AGENT_SCOUT_DISCOVERY=1` to skip anything slow during this look.

The Antigravity ACP agent has no PATH binary. It counts as installed when an
unpacked runtime is in `~/.helm/tools/antigravity-acp/current` (override with
`antigravityAcpDir` or `AGENT_SCOUT_ANTIGRAVITY_ACP_DIR`).

## How model lists stay fresh

- A list is kept for 10 minutes, in memory and in the state folder. An older
  list is handed back at once while a new one is fetched behind it; `scan`,
  `listModels` and the command line wait for that new one by default.
- A CLI that fails, times out, or suddenly lists nothing never empties a list
  it gave before: the last good list is kept.
- Codex: the account's model cache on disk answers first, then
  `codex debug models` (it refreshes Codex's own online catalog), then
  `codex app-server`. A public manifest adds models Codex has published but
  an older CLI does not list yet.
- Claude Code has no model-list command. Its list is its own config (the
  default and models used per project) plus models.dev plus Anthropic's
  model page, which shows a new model on launch day. Newest first, with dated
  snapshots last. Aliases like `opus` in `settings.json` are resolved to the
  model they run.
- opencode: `opencode models` reads the local catalog; `--refresh` is only
  used when that is empty. OpenCode 2 is run with `--standalone`, so asking
  does not leave its background service running. Effort levels come from
  opencode's own models cache.
- Public catalogs are fetched with a 5 second timeout and retried at most
  every 30 seconds. The last good copy is kept in the state folder, so a run
  that cannot reach them still lists what they said.
- `scan` asks three CLIs at a time. All at once, they fight over the CPU and
  slow ones (`opencode models` takes about five seconds) run past their
  time limits.

## How new-model following works

The state folder keeps, for every CLI account (the CLI plus its home folder),
every model id it has ever listed.

1. The first scan of an account only records what is there. Nothing is
   reported, so installing agent-scout or a CLI that lists a hundred models
   at once is not news.
2. Each later scan compares the list with what was seen. Every id not seen
   before is marked `new: true` and added to `newModels`, once.
3. A list that is still loading or came back empty is never recorded, so a
   network hiccup cannot make old models look new later.

For callers that keep their own short list of models and a default, the
follow helpers do what Helm's pickers do: `saveModelPrefs(key, { default, approved })`
stores them, and each scan of a Claude, Codex or Gemini account then adds a
newly released model to the short list and moves the default to it when the
default was the newest of its line (`claude-opus-5-5` to `claude-opus-6`, but
never `gpt-6-sol` to a different line, a dated snapshot, or an alias).
A model the owner took off the list is never put back. `modelPrefs`,
`modelWatch` (with the last notes) and `dismissModelNews` read and clear it;
`followModels` and `setModelPrefs` are the same steps as pure functions.

## State folder

In order: the `stateDir` option or `--state-dir`, `$AGENT_SCOUT_STATE_DIR`,
`$XDG_STATE_HOME/agent-scout`, `~/.local/state/agent-scout`. Files:

| File | What it holds |
| --- | --- |
| `models-cache.json` | The last model list of each CLI account. |
| `public-catalogs.json` | The last good models.dev (Anthropic and Google parts), Anthropic page and Codex manifest. |
| `follow.json` | Models seen per account, and optional prefs. |
| `signin.json` | Sign-in answers, kept 10 minutes. |
| `cli-latest.json` | Newest published npm versions, kept 6 hours. |

Deleting the folder is safe: the next scan starts over with a first look.

## Tests

```sh
node --test
```

The tests use fake CLIs and local servers. They need no network and none of
the real CLIs.

## License

PolyForm Noncommercial 1.0.0, see [LICENSE](LICENSE).
