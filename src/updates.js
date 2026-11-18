import { isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { ENGINES } from './engines.js';
import { HOME } from './paths.js';
import { readState, writeState } from './state.js';
import { findClis } from './discover.js';
import { PROGRAM_MIN_BYTES, classifyInstall, isNewer, missingModels, parseVersion, run } from './binaries.js';
import { anthropicCurrentModels } from './models.js';

/**
 * Spotting newer CLI versions. From Helm's CliUpdater, minus the part that
 * installs them: agent-scout reports the version, the newest published one
 * (for npm installs), how the CLI was installed, and the one safe command
 * that would update it - and never runs that command.
 *
 * Claude Code knows each model's context size. A build older than the model
 * treats it as 200k and compacts too early. On launch day the build that
 * knows the model is often only on the early ("next") channel, so the report
 * says when Anthropic lists a model this Claude Code does not know, and
 * which early build would.
 */

const LATEST_TTL_MS = 6 * 60 * 60_000;
const FILE = 'cli-latest.json';
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const CLAUDE_TAGS_URL = `https://registry.npmjs.org/-/package/${CLAUDE_PACKAGE}/dist-tags`;

async function claudeEarlyVersion({ env = process.env, fetch: f = globalThis.fetch } = {}) {
  const response = await f(env.AGENT_SCOUT_CLAUDE_TAGS_URL || CLAUDE_TAGS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;
  const tags = await response.json();
  return typeof tags?.next === 'string' ? tags.next : null;
}

async function npmRoot(env, platform) {
  const r = await run('npm', ['root', '-g'], { timeout: 15_000, env, platform });
  return r.ok && r.out[0] && isAbsolute(r.out[0]) ? r.out[0] : null;
}

async function latestVersion(tool, state, { env, platform, now, refresh, offline }) {
  if (tool.method !== 'npm' || !tool.pkg) return null;
  const hit = state.latest[tool.pkg];
  if (!refresh && hit && now() - hit.at < LATEST_TTL_MS) return hit.version;
  if (offline) return hit?.version ?? null;
  const r = await run('npm', ['view', tool.pkg, 'version'], { timeout: 20_000, env, platform });
  const version = r.ok ? parseVersion(r.out[0]) : null;
  if (version) state.latest[tool.pkg] = { version, at: now() };
  return version ?? hit?.version ?? null;
}

/**
 * Every installed CLI: version, how it was installed, whether agent-scout
 * knows a safe way to update it (and the command), the newest published
 * version for npm installs, and for Claude Code the models it does not know.
 *
 * options: clis, env, platform, home, npmRoot (string, null, or function),
 * now, refresh, offline, currentModels, earlyVersion, stateDir, plus
 * findClis' options (path, shell).
 */
export async function checkUpdates(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? HOME;
  const now = options.now ?? Date.now;
  const offline = options.offline ?? (process.env.AGENT_SCOUT_OFFLINE === '1');
  const currentModels = options.currentModels ?? (() => anthropicCurrentModels(options));
  const earlyVersion = options.earlyVersion ?? (() => claudeEarlyVersion({ env, fetch: options.fetch }));

  const clis = options.found ?? await findClis(options);
  const root = options.npmRoot !== undefined
    ? (typeof options.npmRoot === 'function' ? await options.npmRoot() : options.npmRoot)
    : await npmRoot(env, platform);
  const state = readState(FILE, options, {});
  state.latest ??= {};

  const tools = [];
  for (const cli of clis) {
    if (!cli.installed || ENGINES[cli.id]?.managed) continue;
    let real = cli.realPath ?? cli.path;
    try { real = realpathSync(cli.path); } catch { /* keep the link path */ }
    const plan = classifyInstall(cli.id, real, { npmRoot: root, home, platform });
    const latest = await latestVersion(plan, state, { env, platform, now, refresh: options.refresh, offline }).catch(() => null);
    const tool = {
      id: cli.id, label: cli.label, path: cli.path, version: cli.version,
      method: plan.method, canUpdate: plan.canUpdate,
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.command ? { command: { cmd: plan.command.cmd ?? cli.path, args: plan.command.args } } : {}),
      latest: latest ?? null,
      outdated: latest ? isNewer(latest, cli.version) : null,
    };
    if (cli.id === 'claude' && !offline) tool.early = await claudeEarly(cli, real, plan, { currentModels, earlyVersion }).catch(() => null);
    tools.push(tool);
  }
  writeState(FILE, state, options);
  return { checkedAt: new Date(now()).toISOString(), tools };
}

/**
 * If Anthropic lists a model this Claude Code does not know: the missing
 * ids, and the early build to install when it is newer. Null when there is
 * nothing to say (or the file is a launcher script, which can not tell).
 */
async function claudeEarly(cli, real, plan, { currentModels, earlyVersion }) {
  try { if (statSync(real).size < PROGRAM_MIN_BYTES) return null; } catch { return null; }
  const missing = await missingModels(real, await currentModels());
  if (!missing?.length) return null;
  const next = await earlyVersion();
  const newer = !!next && isNewer(next, cli.version);
  return {
    missingModels: missing,
    version: newer ? next : null,
    ...(newer ? {
      command: plan.method === 'npm'
        ? { cmd: 'npm', args: ['install', '-g', `${CLAUDE_PACKAGE}@${next}`] }
        : { cmd: cli.path, args: ['install', next] },
    } : {}),
  };
}
