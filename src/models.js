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

// -------------------------------------------------------------------- codex

async function codexModels(root, environment, key, bin, net, dir) {
  let def = null;
  let effort = null;
  try {
    const toml = readFileSync(join(root, 'config.toml'), 'utf8');
    def = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
    effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch { /* no config */ }

  // The catalog file belongs to this account. It is already useful offline,
  // so return it immediately and let the CLI refresh the cached answer.
  const disk = readCodexDiskCatalog(root);
  if (disk?.models?.length) {
    // Start the public overlay refresh too, but neither catalog is allowed to
    // hold up the usable local answer.
    const catalog = mergeCodexPublishedModels(disk, await codexPublishedModels(net));
    scheduleCodexRefresh(key, root, environment, def, effort, bin, net, dir);
    return codexValue(catalog, def, effort, 'codex model cache');
  }

  // On a headless-only account there is no disk catalog; app-server remains
  // the only account-aware source. Public manifest fetches are nonblocking.
  const { catalog, source } = await codexCatalog(root, environment, bin, net);
  return codexValue(catalog, def, effort, CODEX_SOURCES[source] ?? null);
}

const CODEX_SOURCES = {
  debug: 'codex debug models',
  'app-server': 'codex app-server',
  disk: 'codex model cache',
  public: 'public model manifest',
};

function readCodexDiskCatalog(root) {
  // Codex versions use both names. Prefer the latest valid account cache;
  // an old model_catalog.json must not hide a newer models_cache.json.
  const catalogs = [];
  for (const name of ['model_catalog.json', 'models_cache.json']) {
    try {
      const file = join(root, name);
      const catalog = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(catalog?.models) && catalog.models.length) {
        catalogs.push({ catalog, at: statSync(file).mtimeMs });
      }
    } catch { /* missing or incomplete cache */ }
  }
  return catalogs.sort((a, b) => b.at - a.at)[0]?.catalog ?? null;
}

function codexValue(catalog, def = null, effort = null, source = null) {
  const parsed = parseCodexModelList(catalog?.models ?? []);
  const models = [...parsed.models];
  if (def && !models.includes(def)) models.unshift(def);
  return {
    default: def ?? parsed.default ?? null,
    models,
    labels: parsed.labels,
    effort,
    efforts: parsed.efforts,
    effortsByModel: parsed.effortsByModel,
    defaultEffortByModel: parsed.defaultEffortByModel,
    speeds: parsed.speeds,
    speedByModel: parsed.speedByModel,
    images: parsed.images,
    imagesByModel: Object.fromEntries(models.map((m) => [m, parsed.imagesByModel?.[m] ?? true])),
    source,
  };
}

function scheduleCodexRefresh(key, root, environment, def, effort, bin, net, dir) {
  if (codexRefreshes.has(key) || Date.now() < (codexRetryAt.get(key) ?? 0)) return;
  codexRetryAt.set(key, Date.now() + CODEX_RETRY_MS);
  const job = new Promise((resolve) => setImmediate(resolve)).then(async () => {
    try {
      const result = await codexCatalog(root, environment, bin, net);
      if (!['app-server', 'debug'].includes(result?.source) || !result.catalog?.models?.length) return;
      const fresh = codexValue(result.catalog, def, effort, CODEX_SOURCES[result.source]);
      // Provider discovery can fail or return less than the last usable local
      // cache. Never turn that transient result into an empty list.
      const prior = cache.get(key)?.value;
      if (prior?.models?.length && !fresh.models.length) return;
      setCache(key, { at: Date.now(), value: fresh, dir });
    } catch { /* keep local data and throttle the next provider probe */ }
  }).finally(() => codexRefreshes.delete(key));
  codexRefreshes.set(key, job);
}

/**
 * Normalize Codex app-server's model/list rows without naming model families.
 * The app-server and debug command have used slightly different field names
 * over time, so a newly published model only needs to appear in the provider
 * response for agent-scout to understand it.
 */
export function parseCodexModelList(rows) {
  const models = [];
  const labels = {};
  const effortsByModel = {};
  const defaultEffortByModel = {};
  const speedByModel = {};
  const imagesByModel = {};
  let def = null;

  const text = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  const list = (value) => Array.isArray(value) ? value : [];
  const level = (value) => typeof value === 'string'
    ? value
    : text(value?.reasoningEffort, value?.reasoning_effort, value?.effort, value?.value, value?.id);
  const tier = (value) => typeof value === 'string' ? value : text(value?.id, value?.name, value?.value);

  for (const m of Array.isArray(rows) ? rows : []) {
    const slug = text(m?.model, m?.id, m?.slug);
    if (!slug || /review|reserve/.test(slug) || models.includes(slug)) continue;
    models.push(slug);
    const label = text(m?.displayName, m?.display_name, m?.name);
    if (label) labels[slug] = label;
    if (m?.isDefault || m?.is_default) def ??= slug;

    const levels = list(m?.supportedReasoningEfforts ?? m?.supported_reasoning_efforts
      ?? m?.supportedReasoningLevels ?? m?.supported_reasoning_levels).map(level).filter(Boolean);
    if (levels.length) effortsByModel[slug] = levels;
    // The level a chat on this model starts with when none is configured.
    const start = level(m?.defaultReasoningEffort ?? m?.default_reasoning_effort
      ?? m?.defaultReasoningLevel ?? m?.default_reasoning_level);
    if (start) defaultEffortByModel[slug] = start;

    // What the TUI calls /fast: a service tier this model also answers on.
    const tiers = list(m?.additionalSpeedTiers ?? m?.additional_speed_tiers
      ?? m?.serviceTiers ?? m?.service_tiers).map(tier).filter(Boolean);
    if (tiers.length) speedByModel[slug] = tiers;

    const modalities = m?.inputModalities ?? m?.input_modalities;
    imagesByModel[slug] = Array.isArray(modalities)
      ? modalities.some((modality) => String(modality).toLowerCase() === 'image')
      : m?.supportsImages ?? m?.supports_images ?? true;
  }

  const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const efforts = [...new Set(Object.values(effortsByModel).flat())]
    .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
  const images = models.length ? models.some((model) => imagesByModel[model]) : true;
  return {
    default: def,
    models,
    labels,
    efforts: efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh'],
    effortsByModel,
    defaultEffortByModel,
    speeds: [...new Set(Object.values(speedByModel).flat())],
    speedByModel,
    images,
    imagesByModel,
  };
}

const GENERIC_CODEX_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

const codexRowId = (row) => typeof row === 'string'
  ? row
  : row?.model ?? row?.id ?? row?.slug ?? null;

const codexLabel = (slug) => slug.startsWith('gpt-')
  ? `GPT-${slug.slice(4).split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join('-')}`
  : slug;

/**
 * Add models that the provider has published while an installed Codex CLI is
 * still serving an older local catalog. The manifest is only an additive
 * safety net; app-server remains the source of per-model capabilities.
 */
export function mergeCodexPublishedModels(catalog, published) {
  const out = { ...(catalog ?? {}) };
  const rows = [...(out.models ?? [])];
  const known = new Set(rows.map(codexRowId).filter(Boolean));
  for (const slug of Array.isArray(published) ? published : []) {
    if (typeof slug !== 'string' || !slug.trim() || known.has(slug)) continue;
    known.add(slug);
    rows.push({
      model: slug,
      displayName: codexLabel(slug),
      supportedReasoningEfforts: GENERIC_CODEX_EFFORTS,
      inputModalities: ['text', 'image'],
    });
  }
  out.models = rows;
  return out;
}

/** Keep provider answers available while refreshing the optional public overlay. */
function codexPublishedModels(net = network()) {
  const now = Date.now();
  if (!net.offline
      && now - codexManifestCache.at >= CODEX_MANIFEST_TTL_MS
      && now - codexManifestCache.checkedAt >= PUBLIC_CATALOG_RETRY_MS
      && !codexManifestInflight) {
    codexManifestCache.checkedAt = now;
    codexManifestInflight = (async () => {
      try {
        const response = await net.fetch(process.env.AGENT_SCOUT_CODEX_MODEL_MANIFEST_URL || CODEX_MANIFEST_URL, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`model manifest returned ${response.status}`);
        const manifest = await response.json();
        const models = [...new Set((manifest?.currentModels?.codex ?? [])
          .filter((model) => typeof model === 'string' && model.trim()))];
        if (!models.length) throw new Error('model manifest contained no Codex models');
        codexManifestCache = { at: Date.now(), checkedAt: Date.now(), models };
        savePublic();
        for (const [key, row] of cache) {
          if (discoveries.get(key)?.engine !== 'codex') continue;
          const value = withPublishedCodexModels(row.value, models);
          setCache(key, { at: Date.now(), value, dir: row.dir });
        }
      } catch { /* retain stale data and back off before trying again */ }
    })().finally(() => { codexManifestInflight = null; });
  }
  return Promise.resolve(codexManifestCache.models);
}

function withPublishedCodexModels(value, published) {
  const merged = mergeCodexPublishedModels({ models: value?.models ?? [] }, published);
  const models = [...(value?.models ?? [])];
  const labels = { ...(value?.labels ?? {}) };
  const effortsByModel = { ...(value?.effortsByModel ?? {}) };
  const imagesByModel = { ...(value?.imagesByModel ?? {}) };
  const addedEfforts = [];
  for (const row of merged.models) {
    if (!row || typeof row === 'string' || models.includes(row.model)) continue;
    models.push(row.model);
    labels[row.model] = row.displayName;
    effortsByModel[row.model] = row.supportedReasoningEfforts;
    imagesByModel[row.model] = true;
    addedEfforts.push(...row.supportedReasoningEfforts);
  }
  return {
    ...value,
    models,
    labels,
    effortsByModel,
    efforts: [...new Set([...(value?.efforts ?? []), ...addedEfforts])],
    imagesByModel,
    images: Boolean(value?.images || addedEfforts.length),
  };
}

/**
 * Ask Codex app-server for its provider-backed catalog. This is the
 * important path: Codex can refresh its own remote model catalog, so
 * agent-scout learns about a new model without a new agent-scout release.
 */
async function codexAppServerCatalog(root, environment = {}, bin = 'codex') {
  const child = spawn(bin, ['app-server', '--stdio'], {
    env: { ...process.env, ...environment, CODEX_HOME: root },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let exited = false;

  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const fail = (error) => {
    if (exited) return;
    exited = true;
    rejectPending(error);
  };

  child.stdout.setEncoding('utf8');
  // A provider may exit between app-server startup and the next request. A
  // write to its closed stdin then raises EPIPE asynchronously on the stream,
  // outside the try/catch around `write`; consume it and reject pending calls.
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue;
      const call = pending.get(message.id);
      if (!call) continue;
      pending.delete(message.id);
      clearTimeout(call.timer);
      call.resolve(message);
    }
  });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('codex app-server exited')));

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (exited) return reject(new Error('codex app-server exited'));
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`codex ${method} timed out`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  try {
    const init = await call('initialize', {
      clientInfo: { name: 'agent-scout-model-discovery', title: 'agent-scout model discovery', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (init.error) throw new Error(init.error.message ?? 'codex initialize failed');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');

    const rows = [];
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const response = await call('model/list', cursor ? { cursor } : {});
      if (response.error) throw new Error(response.error.message ?? 'codex model/list failed');
      const result = response.result ?? {};
      rows.push(...(Array.isArray(result) ? result : result.data ?? []));
      const next = result.nextCursor ?? result.next_cursor ?? null;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return { models: rows };
  } finally {
    rejectPending(new Error('codex model discovery stopped'));
    try { child.stdin.end(); } catch { /* already closed */ }
    if (!child.killed) child.kill('SIGTERM');
  }
}

/** Codex provider catalog with its source attached for safe cache promotion. */
async function codexCatalog(root, environment = {}, bin = 'codex', net = network()) {
  void codexPublishedModels(net);
  // debug models refreshes the account catalog. app-server model/list can
  // return bundled or cached rows before its online discovery has finished.
  try {
    const { stdout } = await exec(bin, ['debug', 'models'], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...environment, CODEX_HOME: root },
    });
    const cat = JSON.parse(stdout);
    if (cat?.models?.length) {
      return { catalog: mergeCodexPublishedModels(cat, codexManifestCache.models), source: 'debug' };
    }
  } catch { /* not installed, too old, or no network - fall back to disk */ }
  const live = await codexAppServerCatalog(root, environment, bin).catch(() => null);
  if (live?.models?.length) {
    return { catalog: mergeCodexPublishedModels(live, codexManifestCache.models), source: 'app-server' };
  }

  const cat = readCodexDiskCatalog(root);
  if (cat) return { catalog: mergeCodexPublishedModels(cat, codexManifestCache.models), source: 'disk' };
  return codexManifestCache.models.length
    ? { catalog: mergeCodexPublishedModels(null, codexManifestCache.models), source: 'public' }
    : { catalog: null, source: null };
}

// ------------------------------------------------------------------- claude

// Only what the list shows before Models.dev answers; newest first.
const CLAUDE_FALLBACK_FAMILY = [
  'claude-fable-5-2', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5',
];

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude Code keeps its global config in ~/.claude.json unless CLAUDE_CONFIG_DIR moves it. */
function readClaudeConfig(root) {
  const files = [join(root, '.claude.json')];
  if (root === expand('~/.claude')) files.push(join(dirname(root), '.claude.json'));
  for (const file of files) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* try the next */ }
  }
  return null;
}

/**
 * The Claude Code CLI accepts a model id but does not expose a model-list
 * command. Models.dev is Anthropic's current public catalog, so use it as an
 * additive overlay; the configured model and an already-running session
 * still win when they know more about this account.
 */
async function claudeModels(root, environment = {}, net = network()) {
  const [listed, official] = await Promise.all([modelsDevProvider('anthropic', net), anthropicPublishedModels(net)]);
  const published = {
    models: [...listed.models, ...official.models],
    labels: { ...official.labels, ...listed.labels },
    imagesByModel: listed.imagesByModel,
    releasedAt: { ...official.releasedAt, ...listed.releasedAt },
  };
  const seen = new Set([...CLAUDE_FALLBACK_FAMILY, ...published.models]);
  let def = null;
  const cfg = readClaudeConfig(root);
  if (cfg) {
    // Top-level `model` is the account default; projects carry their own.
    if (typeof cfg.model === 'string') def = cfg.model;
    for (const p of Object.values(cfg.projects ?? {})) {
      if (typeof p?.model === 'string') seen.add(p.model);
    }
  }
  // What a chat started without --model really runs: ANTHROPIC_MODEL, else
  // the account's settings.json - often an alias such as "opus". Its
  // `effortLevel` is the thinking level it starts with.
  let settings = {};
  try { settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) ?? {}; } catch { /* none */ }
  const chosen = [environment.ANTHROPIC_MODEL, settings.env?.ANTHROPIC_MODEL, settings.model]
    .find((v) => typeof v === 'string' && v.trim() && v.trim() !== 'default');
  // Newest first, so a model that shipped this week sits at the top of the
  // list instead of behind two years of older ones (Models.dev dates each).
  const models = newestFirst([...seen], published.releasedAt);
  if (chosen) def = claudeAlias(chosen.trim(), models) ?? def;
  if (def && !models.includes(def)) models.unshift(def);
  const labels = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-fable-5-2': 'Claude Fable 5.2', ...published.labels };
  // `claude --effort`; without a saved level the default depends on the
  // model, so none is claimed. Every model in the family takes image input.
  const effort = CLAUDE_EFFORTS.includes(settings.effortLevel) ? settings.effortLevel : null;
  const sources = ['Claude config'];
  if (listed.models.length) sources.push('models.dev');
  if (official.models.length) sources.push('Anthropic models page');
  if (sources.length === 1) sources.push('built-in list');
  return {
    default: def, models, labels, effort, efforts: CLAUDE_EFFORTS,
    images: true,
    imagesByModel: Object.fromEntries(models.map((m) => [m, published.imagesByModel[m] ?? true])),
    releasedAt: published.releasedAt,
    source: sources.join(' + '),
  };
}

/**
 * A Claude model setting as the id it runs: "opus" and "opusplan" mean the
 * newest Opus, "sonnet[1m]" the newest Sonnet. A full id stays itself.
 */
export function claudeAlias(value, models) {
  const plain = value.replace(/\[[^\]]*\]$/, '');
  if (models.includes(plain) || plain.startsWith('claude-')) return plain;
  const family = /^(opus|sonnet|haiku|fable)(plan)?$/.exec(plain)?.[1];
  return family ? models.find((m) => m.startsWith(`claude-${family}-`) && !isSnapshot(m)) ?? null : null;
}

/** Read one provider's rows from the public Models.dev catalog. */
export function parseModelsDevProvider(catalog, provider) {
  const rows = catalog?.[provider]?.models;
  const models = [];
  const labels = {};
  const imagesByModel = {};
  const releasedAt = {};
  if (!rows || typeof rows !== 'object') return { models, labels, imagesByModel, releasedAt };
  for (const [id, meta] of Object.entries(rows)) {
    if (!id || /review|reserve|deprecated/i.test(id)) continue;
    models.push(id);
    if (typeof meta?.name === 'string' && meta.name.trim()) labels[id] = meta.name.trim();
    if (typeof meta?.attachment === 'boolean') imagesByModel[id] = meta.attachment;
    if (typeof meta?.release_date === 'string' && meta.release_date.trim()) releasedAt[id] = meta.release_date.trim();
  }
  return { models, labels, imagesByModel, releasedAt };
}

/** A dated snapshot ("claude-haiku-4-5-20251001") is a pin, not a new choice. */
const isSnapshot = (id) => /-\d{8}$/.test(id);

/**
 * Newest release first; ids the catalog does not date keep their order and
 * sit between the dated ones and the pinned snapshots, which go last. A
 * stable sort, so two models released the same day stay in catalog order.
 */
export function newestFirst(ids, releasedAt = {}) {
  const rank = (id) => (isSnapshot(id) ? 2 : releasedAt[id] ? 0 : 1);
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => rank(a.id) - rank(b.id)
      || (releasedAt[b.id] ?? '').localeCompare(releasedAt[a.id] ?? '')
      || a.i - b.i)
    .map((x) => x.id);
}

/** Resolves once catalog refreshes already in progress have ended. */
export async function modelsSettled(engine, home, launcher = null) {
  const pending = () => engine ? pendingRefreshes(engine, modelsKey(engine, home, launcher)) : [
    modelsDevInflight, anthropicInflight, codexManifestInflight, ...inflight.values(),
    ...codexRefreshes.values(), ...publicRefreshes.values(),
  ].filter(Boolean);
  // A public fetch can start an account rebuild. Follow that work too,
  // without waiting for another account's CLI or another provider.
  for (let jobs = pending(); jobs.length; jobs = pending()) await Promise.allSettled(jobs);
}

/** Return stale public data immediately and refresh it once in the background. */
function modelsDevCatalog(net = network()) {
  const now = Date.now();
  if (!net.offline
      && now - modelsDevCache.at >= MODELS_DEV_TTL_MS
      && now - modelsDevCache.checkedAt >= PUBLIC_CATALOG_RETRY_MS
      && !modelsDevInflight) {
    modelsDevCache.checkedAt = now;
    modelsDevInflight = (async () => {
      try {
        const response = await net.fetch(process.env.AGENT_SCOUT_MODELS_DEV_URL || MODELS_DEV_URL, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
        const catalog = await response.json();
        if (!catalog || typeof catalog !== 'object') throw new Error('models.dev returned no catalog');
        modelsDevCache = { at: Date.now(), checkedAt: Date.now(), catalog };
        savePublic();
        refreshDiscoveredModels(new Set(['claude', 'gemini']));
      } catch { /* keep the last good catalog and back off before retrying */ }
    })().finally(() => { modelsDevInflight = null; });
  }
  return Promise.resolve(modelsDevCache.catalog ?? {});
}

async function modelsDevProvider(provider, net) {
  return parseModelsDevProvider(await modelsDevCatalog(net), provider);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const stripLinks = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

/**
 * Read Anthropic's model page: the comparison table gives each current
 * model's name and API id. Its retirement date is "not sooner than" one year
 * after release, so a year back from it dates a model that Models.dev does
 * not know yet. The "Legacy models" links add the older ids.
 */
export function parseAnthropicModelsPage(text) {
  const out = { models: [], current: [], labels: {}, releasedAt: {} };
  const page = String(text ?? '');
  const rows = page.split('\n').filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const first = (pattern) => rows.find((r) => pattern.test(stripLinks(r[0] ?? '')));
  const header = first(/^Feature$/i);
  const ids = first(/^Claude API ID$/i);
  const retire = first(/^Retirement$/i);
  const add = (id, label) => {
    if (!out.models.includes(id)) out.models.push(id);
    if (label && !out.labels[id]) out.labels[id] = label;
  };
  for (let i = 1; header && ids && i < ids.length; i++) {
    const id = /`(claude-[a-z0-9-]+)`/.exec(ids[i])?.[1];
    if (!id) continue;
    add(id, stripLinks(header[i] ?? ''));
    if (!out.current.includes(id)) out.current.push(id);
    const when = /([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(retire?.[i] ?? '');
    const month = when ? MONTHS.indexOf(when[1].toLowerCase()) : -1;
    if (month >= 0) {
      out.releasedAt[id] = new Date(Date.UTC(Number(when[3]) - 1, month, Number(when[2]))).toISOString().slice(0, 10);
    }
  }
  const legacy = /Legacy models[^\n]*/i.exec(page)?.[0] ?? '';
  for (const m of legacy.matchAll(/\[(Claude [^\]]+)\]\([^)]*\/models\/([a-z]+-\d+(?:-\d+)?)\/overview\)/g)) {
    add(`claude-${m[2]}`, m[1]);
  }
  return out;
}

/** Return the last good page at once and refresh it in the background. */
function anthropicPublishedModels(net = network()) {
  const now = Date.now();
  if (!net.offline
      && now - anthropicCache.at >= MODELS_DEV_TTL_MS
      && now - anthropicCache.checkedAt >= PUBLIC_CATALOG_RETRY_MS
      && !anthropicInflight) {
    anthropicCache.checkedAt = now;
    anthropicInflight = (async () => {
      try {
        const response = await net.fetch(process.env.AGENT_SCOUT_ANTHROPIC_MODELS_URL || ANTHROPIC_MODELS_URL, {
          headers: { accept: 'text/markdown, text/plain' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Anthropic model page returned ${response.status}`);
        const page = parseAnthropicModelsPage(await response.text());
        if (!page.models.length) throw new Error('Anthropic model page lists no models');
        anthropicCache = { at: Date.now(), checkedAt: Date.now(), page };
        savePublic();
        refreshDiscoveredModels(new Set(['claude']));
      } catch { /* keep the last good page and back off before retrying */ }
    })().finally(() => { anthropicInflight = null; });
  }
  return Promise.resolve(anthropicCache.page ?? { models: [], current: [], labels: {}, releasedAt: {} });
}

/** The current lineup on Anthropic's page (not the legacy ids), fetched now if needed. */
export async function anthropicCurrentModels(options = {}) {
  void anthropicPublishedModels(network(options));
  if (anthropicInflight) await anthropicInflight;
  return anthropicCache.page?.current ?? [];
}

