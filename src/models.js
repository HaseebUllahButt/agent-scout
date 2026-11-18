import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { ENGINES } from './engines.js';
import { HOME, expand, stateDir } from './paths.js';
import { readState, writeState } from './state.js';

const exec = promisify(execFile);

/**
 * Which models a CLI on this machine can run, read from the CLI's own
 * records rather than a list baked into agent-scout that goes stale in a
 * month.
 *
 *   codex       `codex debug models`, falling back to app-server, then a
 *               model_catalog.json / models_cache.json on disk
 *   claude      the account's .claude.json remembers the last model per project;
 *               Models.dev and Anthropic's own model page supply the current
 *               public Anthropic catalog
 *   opencode    `opencode models` reads the local catalog; `--refresh` is only
 *               used when the local command cannot provide model rows
 *   devin       `devin models list --format json` (with text fallback) - uid plus
 *               display name; thinking level is baked into each model name
 *   antigravity `agy models`
 *   grok, pi, omp, cursor, kimi   their own list commands; gemini Models.dev
 *
 * `home` is the account's home directory (CODEX_HOME etc.), so a personal
 * account reports its own default.
 *
 * Asking the CLI costs a process, so the answer is held. A catalogue changes
 * when a CLI is upgraded or its config is edited, neither of which is urgent
 * to notice, so it is held for ten minutes - in memory, and in the state
 * folder so the next run of the command line gets it too. An older answer is
 * still handed back while a new one is fetched behind it, and it is what is
 * kept when the CLI fails or suddenly lists nothing.
 */
const CACHE_MS = 10 * 60_000;
const cache = new Map();
const CODEX_MANIFEST_TTL_MS = 10 * 60_000;
const CODEX_MANIFEST_URL = 'https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json';
const MODELS_DEV_TTL_MS = 10 * 60_000;
const MODELS_DEV_URL = 'https://models.dev/api.json';
// Anthropic's own model page shows a new model on launch day. Models.dev can
// take days, so a new Claude model would be missing from the list.
const ANTHROPIC_MODELS_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview.md';
const PUBLIC_CATALOG_RETRY_MS = 30_000;
const CODEX_RETRY_MS = 60_000;
let codexManifestCache = { at: 0, checkedAt: 0, models: [] };
let codexManifestInflight = null;
let modelsDevCache = { at: 0, checkedAt: 0, catalog: null };
let modelsDevInflight = null;
let anthropicCache = { at: 0, checkedAt: 0, page: null };
let anthropicInflight = null;
const discoveries = new Map();
const codexRetryAt = new Map();
const codexRefreshes = new Map();
const publicRefreshes = new Map();
const lastErrors = new Map();

const CACHE_FILE = 'models-cache.json';
const loadedDirs = new Set();

// ------------------------------------------------------------------ network

/**
 * How public catalogs are fetched. `offline` (or AGENT_SCOUT_OFFLINE=1)
 * skips every network call; `fetch` replaces the global one (tests).
 */
function network(options = {}) {
  const env = process.env;
  return {
    fetch: options.fetch ?? globalThis.fetch,
    offline: options.offline ?? (env.AGENT_SCOUT_OFFLINE === '1' || env.AGENT_SCOUT_OFFLINE === 'true'),
  };
}

// --------------------------------------------------------------- disk cache

/** Seed the in-memory cache from the state folder once per folder. */
function loadDisk(dir) {
  if (!dir || loadedDirs.has(dir)) return;
  loadedDirs.add(dir);
  const saved = readState(CACHE_FILE, { stateDir: dir });
  for (const [key, row] of Object.entries(saved.entries ?? {})) {
    if (cache.has(key) || !row || typeof row.at !== 'number' || !row.value || typeof row.value !== 'object') continue;
    cache.set(key, { at: row.at, value: row.value, dir });
  }
}

function saveDisk(dir) {
  if (!dir) return;
  const entries = {};
  for (const [key, row] of cache) if (row.dir === dir) entries[key] = { at: row.at, value: row.value };
  writeState(CACHE_FILE, { entries }, { stateDir: dir });
}

// The public catalogs are kept too. A daemon holds them in memory for
// hours; a command run starts cold, and models.dev is a 7 MB answer that a
// busy machine does not always fetch within its five seconds. Without a kept
// copy, such a run fell back to the short built-in Claude list. Only the
// providers agent-scout reads are kept.
const PUBLIC_FILE = 'public-catalogs.json';
const MODELS_DEV_PROVIDERS = ['anthropic', 'google'];
let publicDir = null;
const publicLoaded = new Set();

function loadPublic(dir) {
  if (!dir) return;
  publicDir = dir;
  if (publicLoaded.has(dir)) return;
  publicLoaded.add(dir);
  const saved = readState(PUBLIC_FILE, { stateDir: dir });
  const fresher = (row, mem) => row && typeof row.at === 'number' && row.at > mem.at;
  if (fresher(saved.modelsDev, modelsDevCache) && saved.modelsDev.catalog && typeof saved.modelsDev.catalog === 'object') {
    modelsDevCache = { at: saved.modelsDev.at, checkedAt: 0, catalog: saved.modelsDev.catalog };
  }
  if (fresher(saved.anthropic, anthropicCache) && Array.isArray(saved.anthropic.page?.models)) {
    anthropicCache = { at: saved.anthropic.at, checkedAt: 0, page: saved.anthropic.page };
  }
  if (fresher(saved.codexManifest, codexManifestCache) && Array.isArray(saved.codexManifest.models)) {
    codexManifestCache = { at: saved.codexManifest.at, checkedAt: 0, models: saved.codexManifest.models };
  }
}

function savePublic() {
  if (!publicDir) return;
  const pick = (catalog) => Object.fromEntries(MODELS_DEV_PROVIDERS.filter((p) => catalog?.[p]).map((p) => [p, catalog[p]]));
  writeState(PUBLIC_FILE, {
    ...(modelsDevCache.catalog ? { modelsDev: { at: modelsDevCache.at, catalog: pick(modelsDevCache.catalog) } } : {}),
    ...(anthropicCache.page ? { anthropic: { at: anthropicCache.at, page: anthropicCache.page } } : {}),
    ...(codexManifestCache.models.length ? { codexManifest: { at: codexManifestCache.at, models: codexManifestCache.models } } : {}),
  }, { stateDir: publicDir });
}

function setCache(key, row) {
  cache.set(key, row);
  if (row.dir) saveDisk(row.dir);
}

// ---------------------------------------------------------------- the cache

function pendingRefreshes(engine, key) {
  return [inflight.get(key), publicRefreshes.get(key),
    ...(engine === 'codex' ? [codexRefreshes.get(key), codexManifestInflight] : []),
    ...(['claude', 'gemini'].includes(engine) ? [modelsDevInflight] : []),
    ...(engine === 'claude' ? [anthropicInflight] : []),
  ].filter(Boolean);
}

/**
 * The model catalog of one CLI account, in Helm's catalog shape:
 * { default, models: [ids], labels, effort, efforts, effortsByModel, ...,
 *   source, refreshing }.
 *
 * options
 *   home      the account home (default: the CLI's env variable or default)
 *   env       extra environment for the CLI (merged over process.env)
 *   bin       the program to run (default: the CLI's name, found on PATH)
 *   launcher  {cmd, args} of an account run through a wrapper script
 *             (discover.js wrappedEngine): its own binary can only be
 *             reached that way
 *   settled   wait for refreshes already running before answering
 *   refresh   ignore a cached answer's age (it is still the fallback)
 *   cache     false keeps the answer out of the state folder
 *   stateDir, offline, fetch
 */
export async function modelCatalog(engine, options = {}) {
  const { home = null, env: environment = {}, launcher = null, settled = false, refresh = false } = options;
  const dir = options.cache === false ? null : stateDir(options);
  loadDisk(dir);
  loadPublic(dir);
  const key = modelsKey(engine, home, launcher);
  if (settled) await modelsSettled(engine, home, launcher);
  const answer = (value) => ({ ...value, refreshing: pendingRefreshes(engine, key).length > 0 });
  const hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return answer(hit.value);
  // Some CLIs take seconds to list (agy asks the server every time). A list
  // that has aged out is still a far better answer than a spinner: hand it
  // back and fetch the new one behind it.
  const ctx = { engine, home, environment, launcher, bin: options.bin ?? null, net: network(options), dir };
  if (hit?.value) {
    refreshModels(key, ctx, hit).catch(() => {});
    return answer(hit.value);
  }
  return answer(await refreshModels(key, ctx, hit));
}

const modelsKey = (engine, home, launcher) => {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  return `${engine}|${root}|${launcher ? [launcher.cmd, ...launcher.args].join(' ') : ''}`;
};

/** The held answer for an account, if there is one - never spawns anything. */
export function peekModels(engine, home, launcher = null) {
  return cache.get(modelsKey(engine, home, launcher))?.value ?? null;
}

/** The last error a refresh of this account hit, if it ended with nothing. */
export function modelsError(engine, home, launcher = null) {
  return lastErrors.get(modelsKey(engine, home, launcher)) ?? null;
}

/** Fill the cache from output something else already fetched (signin.js). */
export function primeModels(engine, home, launcher, value, options = {}) {
  const dir = options.cache === false ? null : stateDir(options);
  setCache(modelsKey(engine, home, launcher), { at: Date.now(), value, dir });
}

const inflight = new Map();

/** A session's live choices must never overwrite another session's cached catalog. */
export function mergeLiveModelCatalog(catalog, live, { all = false } = {}) {
  const models = { ...catalog };
  let extra = [];
  if (!live) return { models, extra };
  if (live.models?.length) {
    const advertised = new Set(live.models);
    extra = all ? [] : models.models.filter((m) => !advertised.has(m));
    models.models = all ? [...new Set([...live.models, ...models.models])] : [...live.models];
  }
  models.labels = { ...(models.labels ?? {}), ...(live.labels ?? {}) };
  // These levels belong to the current model only. In particular, [] is
  // authoritative: switching to a model without thinking removes the chip.
  models.effortsByModel = { ...(models.effortsByModel ?? {}) };
  if (live.current) models.effortsByModel[live.current] = [...(live.efforts ?? [])];
  models.effort = live.effort ?? null;
  models.efforts = [];
  if (live.current && !models.default) models.default = live.current;
  return { models, extra };
}

function refreshModels(key, ctx, hit) {
  if (inflight.has(key)) return inflight.get(key);
  discoveries.set(key, ctx);
  const { engine, home, environment, launcher, net } = ctx;
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  const bin = ctx.bin ?? ENGINES[engine]?.bin ?? engine;
  const job = (async () => {
    let value = { default: null, models: [] };
    try {
      if (engine === 'codex') value = await codexModels(root, environment, key, bin, net, ctx.dir);
      else if (engine === 'claude') value = await claudeModels(root, environment, net);
      else if (engine === 'opencode' || engine === 'opencode2') value = await opencodeModels(root, bin, environment, net);
      else if (engine === 'devin') value = await devinModels(root, environment, bin);
      else if (engine === 'grok') value = await grokModels(root, environment, bin);
      else if (engine === 'pi' || engine === 'omp') value = await piModels(engine, root, environment, bin);
      else if (engine === 'cursor') value = await cursorModels(environment, ctx.bin);
      else if (engine === 'gemini') value = await geminiModels(net);
      else if (engine === 'antigravity') value = await agyModels(root, environment, launcher, bin);
      else if (engine === 'kimi') value = await kimiModels(environment, bin);
      lastErrors.delete(key);
    } catch (err) {
      lastErrors.set(key, String(err?.message || err).split('\n')[0].slice(0, 300));
      // A transient provider or CLI failure should not make a previously known
      // model disappear from the list. The next expiry will try discovery
      // again, while this answer keeps the caller useful in the meantime.
      if (hit?.value) value = hit.value;
    }
    // An empty answer from a CLI that listed models before is a hiccup, not news.
    if (!value.models?.length && hit?.value?.models?.length) value = hit.value;
    setCache(key, { at: Date.now(), value, dir: ctx.dir });
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Rebuild already-listed account caches after an optional public catalog updates. */
function refreshDiscoveredModels(engines) {
  for (const [key, discovery] of discoveries) {
    if (!engines.has(discovery.engine) || publicRefreshes.has(key)) continue;
    // Track this work before the public fetch ends. A waiting caller must not
    // receive the old account cache between the fetch and its rebuild.
    const job = (async () => {
      // Wait for every public list, so the rebuild never runs with one of
      // them half fetched and then gets skipped when it lands.
      const lists = [modelsDevInflight, discovery.engine === 'claude' ? anthropicInflight : null];
      await Promise.allSettled(lists.filter(Boolean));
      const current = inflight.get(key);
      if (current) await current.catch(() => {});
      const hit = cache.get(key);
      try {
        await refreshModels(key, discovery, hit);
      } catch { /* keep the prior account-specific answer */ }
    })().finally(() => publicRefreshes.delete(key));
    publicRefreshes.set(key, job);
  }
}

