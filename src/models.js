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

