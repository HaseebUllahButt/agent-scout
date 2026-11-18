import { ENGINES, cliHome, resolveCliId } from './engines.js';
import { expand } from './paths.js';
import { findClis } from './discover.js';
import { checkSignedIn } from './signin.js';
import { modelCatalog, modelsError, setAsideSignedOut } from './models.js';
import { FOLLOWED, accountKey, isSuccessor, observeModels } from './follow.js';

/** The CLIs agent-scout knows how to ask for a model list. */
export const MODEL_CLIS = new Set(['codex', 'claude', 'opencode', 'opencode2', 'devin', 'grok', 'pi', 'omp', 'cursor', 'gemini', 'antigravity', 'kimi']);

function requireCli(name) {
  const id = resolveCliId(name);
  if (!id) throw new Error(`unknown CLI: ${name} (known: ${Object.keys(ENGINES).join(', ')})`);
  return id;
}

/** A catalog in Helm's shape as the list agent-scout reports. */
export function normalizeCatalog(cli, catalog) {
  const list = setAsideSignedOut(catalog ?? { models: [] });
  const refused = new Set(list.signedOut?.length ? (list.more ?? []) : []);
  const ids = [...new Set([...(list.models ?? []), ...(list.more ?? [])])];
  const labels = list.labels ?? {};
  const byModel = list.effortsByModel ?? {};
  const effortsFor = (m) => [...(Object.hasOwn(byModel, m) ? byModel[m] ?? [] : list.efforts ?? [])];
  const def = list.default ?? null;
  const models = ids.map((id) => {
    const efforts = effortsFor(id);
    // The account's saved level is what a chat starts with, when the model
    // takes it; otherwise the model's own starting level, if the CLI says.
    const saved = list.effort;
    const defaultEffort = saved && (!efforts.length || efforts.includes(saved))
      ? saved
      : list.defaultEffortByModel?.[id] ?? null;
    const images = list.imagesByModel && Object.hasOwn(list.imagesByModel, id)
      ? !!list.imagesByModel[id]
      : typeof list.images === 'boolean' ? list.images : null;
    return {
      id,
      label: labels[id] ?? id,
      default: id === def,
      efforts,
      defaultEffort,
      images,
      ...(refused.has(id) ? { signedOut: true } : {}),
      new: false,
    };
  });
  return {
    cli,
    defaultModel: def,
    defaultEffort: list.effort ?? null,
    models,
    modelSource: list.source ?? null,
    refreshing: !!list.refreshing,
    ...(list.signedOut?.length ? { signedOutProviders: [...list.signedOut] } : {}),
  };
}

/**
 * The models one CLI can run: { cli, defaultModel, defaultEffort, models:
 * [{ id, label, default, efforts, defaultEffort, images, new }], modelSource }.
 *
 * options: home, env, bin, launcher, refresh, wait (default true: wait for
 * a refresh running behind a cached answer), cache, stateDir, offline, fetch.
 */
export async function listModels(cli, options = {}) {
  const id = requireCli(cli);
  const home = options.home ?? cliHome(id, { env: options.env ?? process.env });
  const opts = { ...options, home };
  let catalog = MODEL_CLIS.has(id) ? await modelCatalog(id, opts) : { models: [] };
  if (options.wait !== false && catalog.refreshing) {
    catalog = await modelCatalog(id, { ...opts, refresh: false, settled: true });
  }
  const out = normalizeCatalog(id, catalog);
  out.error = out.models.length ? null : modelsError(id, home, options.launcher ?? null);
  return out;
}

/**
 * Run `fn` over `items`, at most `limit` at a time, keeping their order.
 * Several CLIs listing models at once fight over the CPU: `opencode models`
 * alone takes about five seconds, and next to five other CLIs it ran past
 * its eight-second limit.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Every CLI agent-scout knows: whether it is installed, where, which
 * version, whether it is signed in, and the models it can run. Installed
 * CLIs are asked a few at a time (`concurrency`, default 3). New models since the last scan (kept in
 * the state folder) are marked and listed; `track: false` leaves that
 * record alone.
 *
 * options: clis, refresh, track, env, homes, path, shell, stateDir, cache,
 * offline, fetch, signin (false skips sign-in checks), concurrency.
 */
export async function scan(options = {}) {
  const scannedAt = new Date().toISOString();
  const env = options.env ?? process.env;
  const found = await findClis(options);
  const newModels = [];
  const clis = await mapLimit(found, options.concurrency ?? 3, async (cli) => {
    const entry = {
      id: cli.id,
      label: cli.label,
      aliases: cli.aliases,
      installed: cli.installed,
      path: cli.path,
      realPath: cli.realPath,
      onPath: cli.onPath,
      version: cli.version,
      home: cli.home,
      signedIn: null,
      defaultModel: null,
      defaultEffort: null,
      models: [],
      modelSource: null,
      error: null,
    };
    if (!cli.installed) return entry;
    const home = cli.home;
    const common = {
      env, home, bin: cli.path, refresh: options.refresh, stateDir: options.stateDir,
      cache: options.cache, offline: options.offline, fetch: options.fetch,
    };
    try {
      if (options.signin !== false) entry.signedIn = await checkSignedIn(cli.id, common);
    } catch { entry.signedIn = null; }
    if (!MODEL_CLIS.has(cli.id)) return entry;
    try {
      const list = await listModels(cli.id, common);
      entry.defaultModel = list.defaultModel;
      entry.defaultEffort = list.defaultEffort;
      entry.models = list.models;
      entry.modelSource = list.modelSource;
      if (list.signedOutProviders) entry.signedOutProviders = list.signedOutProviders;
      if (!list.models.length) {
        entry.error = list.error ?? (entry.signedIn === false ? 'signed out' : 'no models found');
      } else if (options.track !== false && !list.refreshing) {
        const ids = list.models.map((m) => m.id);
        const labels = Object.fromEntries(list.models.map((m) => [m.id, m.label]));
        const seen = observeModels(accountKey(cli.id, expand(home)), ids, labels,
          { stateDir: options.stateDir, follow: FOLLOWED.has(cli.id) });
        const fresh = new Set(seen.fresh);
        for (const m of entry.models) m.new = fresh.has(m.id);
        for (const id of seen.fresh) {
          newModels.push({ cli: cli.id, id, label: labels[id] ?? id, successor: isSuccessor(id, seen.known) });
        }
        if (seen.notes.length) entry.followed = seen.notes;
      }
    } catch (err) {
      entry.error = String(err?.message || err).split('\n')[0];
    }
    return entry;
  });
  return { scannedAt, clis, newModels };
}

/** Models that appeared since the last call (or the last scan), across all installed CLIs. */
export async function newModels(options = {}) {
  return (await scan({ ...options, track: true })).newModels;
}
