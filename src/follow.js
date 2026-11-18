import { readState, writeState } from './state.js';

/**
 * Following new models as they are released.
 *
 * Every account (a CLI plus its home folder, or any key the caller picks)
 * has a small record in the state folder (follow.json):
 *
 *   seen     every model id this account's catalog has ever listed
 *   prefs    optional { default, approved }: the caller's own short list and
 *            default model. New models join the short list by themselves,
 *            and the default moves to a newer model of its own line.
 *   hidden   models the owner took off the short list; never put back
 *   auto     false switches joining (not noticing) off
 *   news     the last few notes about models that joined by themselves
 *
 * The first look at an account only records what is there, so installing
 * agent-scout (or a CLI upgrade that lists a hundred models at once) reports
 * nothing by surprise. From Helm's settings.js syncNewModels.
 */

const FILE = 'follow.json';

// Only the CLIs whose model names say what replaces what. An aggregator
// (opencode lists hundreds, and a new login changes them all) would flood
// a picker, so those are reported as new but never moved into prefs.
export const FOLLOWED = new Set(['claude', 'codex', 'gemini']);

/** The key agent-scout uses for one CLI account. */
export const accountKey = (cli, home) => `${cli}|${home ?? ''}`;

/**
 * A model id as a "line" and a version, or null when unsure. A line is what
 * a new release replaces: claude-opus-5-5 -> {claude-opus, [5,5]}; gpt-5.3-codex
 * -> {gpt-codex, [5,3]}. A dated snapshot is a pin, so it is flagged. Aliases
 * ("opus"), effort-suffixed ids and anything else odd return null, and null
 * means do nothing.
 */
export function modelLine(id) {
  if (typeof id !== 'string') return null;
  const ver = (v) => v.split(/[-.]/).map(Number);
  let m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})?)(-\d{8})?$/.exec(id);
  if (m) return { line: `claude-${m[1]}`, version: ver(m[2]), pin: !!m[3] };
  // The older spelling puts the version first: claude-3-5-sonnet-20241022.
  m = /^claude-(\d+(?:-\d{1,2})?)-([a-z]+)(-\d{8})?$/.exec(id);
  if (m) return { line: `claude-${m[2]}`, version: ver(m[1]), pin: !!m[3] };
  m = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z]+)*)$/.exec(id);
  if (m) return { line: `gpt${m[2]}`, version: ver(m[1]), pin: false };
  m = /^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-[a-z]+)*?)(-preview)?$/.exec(id);
  if (m) return { line: `gemini-${m[2]}`, version: ver(m[1]), pin: false };
  return null;
}

/** Positive when version a is newer than b (missing parts count as zero). */
export const newerVersion = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const lines = (list) => list.flatMap((id) => { const l = modelLine(id); return l ? [{ id, ...l }] : []; });

const clean = (state) => {
  const s = state && typeof state === 'object' ? state : {};
  return {
    ...(Array.isArray(s.seen) ? { seen: [...s.seen] } : {}),
    ...(s.prefs && typeof s.prefs === 'object'
      ? { prefs: { default: s.prefs.default ?? null, approved: [...(s.prefs.approved ?? [])] } }
      : {}),
    ...(Array.isArray(s.hidden) && s.hidden.length ? { hidden: [...s.hidden] } : {}),
    ...(s.auto === false ? { auto: false } : {}),
    ...(Array.isArray(s.news) && s.news.length ? { news: [...s.news] } : {}),
  };
};

/**
 * Pure: notice models in `ids` this account never saw, and let them join:
 * onto the approved list (so they show in pickers), and, when the default
 * was the newest of its line, as the new default. Only lines we can read are
 * touched (modelLine); an owner's removal is never undone (`hidden`); the
 * first look just records what is there.
 *
 * Returns { state, first, fresh, notes }:
 *   fresh  every id not seen before (any CLI, readable name or not)
 *   notes  [{ id, label, isDefault }] for models that joined the prefs
 */
export function followModels(state, ids, labels = {}, { follow = true } = {}) {
  const next = clean(state);
  const have = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x.trim()))];
  if (!have.length) return { state: next, first: false, fresh: [], notes: [] };
  if (!next.seen) { next.seen = have; return { state: next, first: true, fresh: [], notes: [] }; }

  const known = new Set(next.seen);
  const fresh = have.filter((m) => !known.has(m));
  if (!fresh.length) return { state: next, first: false, fresh, notes: [] };
  const before = next.seen;
  next.seen = [...before, ...fresh].slice(-3000);
  const prefs = next.prefs;
  const notes = [];
  if (follow && next.auto !== false && prefs) {
    const hidden = new Set(next.hidden ?? []);
    const old = lines(before);
    // Newer than everything of its line we knew: a late-arriving old model
    // (a catalog that was partial the first time) is not news.
    const nextUp = lines(fresh).filter((c) => !c.pin && !hidden.has(c.id)
      && !old.some((o) => o.line === c.line && newerVersion(c.version, o.version) <= 0));
    const label = (id) => labels?.[id] ?? id;
    const approved = [...(prefs.approved ?? [])];
    let moved = null;
    const cur = lines([prefs.default ?? ''])[0];
    if (cur && !cur.pin && !old.some((o) => o.line === cur.line && newerVersion(o.version, cur.version) > 0)) {
      moved = nextUp.filter((c) => c.line === cur.line && newerVersion(c.version, cur.version) > 0)
        .sort((a, b) => newerVersion(b.version, a.version))[0] ?? null;
      if (moved) prefs.default = moved.id;
    }
    for (const c of nextUp) {
      // With no short list everything already shows; there is nothing to add to.
      if (approved.length && !approved.includes(c.id)) approved.push(c.id);
      if (approved.length || c === moved) notes.push({ id: c.id, label: label(c.id), isDefault: c === moved });
    }
    prefs.approved = approved;
    if (notes.length) next.news = [...(next.news ?? []), ...notes].slice(-5);
  }
  return { state: next, first: false, fresh, notes };
}

/**
 * Pure: whether a fresh id is a newer release of a line the account already
 * knew (claude-opus-5-6 after claude-opus-5-5), as opposed to an old model
 * that only now showed up or a name agent-scout cannot read.
 */
export function isSuccessor(id, knownIds) {
  const c = modelLine(id);
  if (!c || c.pin) return false;
  const old = lines(knownIds ?? []).filter((o) => o.line === c.line);
  return old.length > 0 && old.every((o) => newerVersion(c.version, o.version) > 0);
}

/**
 * Pure: replace an account's prefs wholesale. An empty approved list means
 * "offer everything", so with no default either there is nothing to keep.
 * `auto` (add new models by themselves) is the one part that is not wholesale:
 * left out, it is kept. `keepApproved` is for a screen holding an old copy of
 * the list: it sets the default and leaves the list alone, so it can neither
 * undo a model that joined meanwhile nor "remove" it.
 */
export function setModelPrefs(state, { default: def = null, approved = [], auto, keepApproved = false } = {}) {
  const next = clean(state);
  const name = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const before = next.prefs?.approved ?? [];
  const list = keepApproved ? before : [...new Set((Array.isArray(approved) ? approved : []).map(name).filter(Boolean))];
  const pick = name(def);
  if (!pick && !list.length) delete next.prefs;
  else next.prefs = { default: pick, approved: list };
  // Taking a model off a short list is a choice: remember it, so new-model
  // sync never puts it back. Clearing the whole list means "offer all", which
  // is not a choice about any one model. Adding it back forgets the choice.
  if (list.length) {
    const hidden = new Set(next.hidden ?? []);
    for (const m of before) if (!list.includes(m)) hidden.add(m);
    for (const m of list) hidden.delete(m);
    next.hidden = [...hidden].slice(-500);
  }
  if (typeof auto === 'boolean') next.auto = auto;
  return clean(next);
}

// ------------------------------------------------------- the state folder

const load = (options) => readState(FILE, options, {}).accounts ?? {};
const save = (accounts, options) => writeState(FILE, { accounts }, options);

/** The stored follow record of one account (see the top of this file). */
export function followState(key, options = {}) {
  return clean(load(options)[key]);
}

function update(key, options, fn) {
  const accounts = load(options);
  const result = fn(clean(accounts[key]));
  const state = result?.state ?? result;
  if (Object.keys(state).length) accounts[key] = state; else delete accounts[key];
  save(accounts, options);
  return result;
}

/**
 * Record a fresh catalog for an account: { first, fresh, notes }.
 * `follow: false` only notices; prefs are left as they are.
 */
export function observeModels(key, ids, labels = {}, options = {}) {
  const have = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x.trim());
  if (!have.length) return { first: false, fresh: [], notes: [], known: followState(key, options).seen ?? [] };
  let known = [];
  const result = update(key, options, (state) => {
    known = state.seen ?? [];
    return followModels(state, have, labels, options);
  });
  return { first: result.first, fresh: result.fresh, notes: result.notes, known };
}

/** Helm's syncNewModels: record the catalog and return the notes made, or []. */
export function syncNewModels(key, ids, labels = {}, options = {}) {
  return observeModels(key, ids, labels, options).notes;
}

/** The account's model prefs, or null - an absent entry means "offer all". */
export function modelPrefs(key, options = {}) {
  const p = followState(key, options).prefs;
  return p && (p.default || p.approved?.length) ? { default: p.default ?? null, approved: p.approved ?? [] } : null;
}

export function saveModelPrefs(key, prefs = {}, options = {}) {
  update(key, options, (state) => setModelPrefs(state, prefs));
  return modelPrefs(key, options);
}

/** Whether new models join by themselves (on unless switched off), and the notes about the last ones. */
export function modelWatch(key, options = {}) {
  const s = followState(key, options);
  return { auto: s.auto !== false, news: s.news ?? [] };
}

/** The owner has seen the notes about models that joined by themselves. */
export function dismissModelNews(key, options = {}) {
  update(key, options, (state) => { delete state.news; return state; });
}

/**
 * Let new models in a fresh catalog join the account's prefs and, when the
 * default was the newest of its line, become the default. Only for CLIs
 * whose model names say what replaces what (FOLLOWED). A catalog still
 * waiting on the public list is half a picture, so it waits.
 */
export function followNewModels(cli, key, catalog, options = {}) {
  if (!FOLLOWED.has(cli) || !catalog?.models?.length || catalog.refreshing) return [];
  try { return syncNewModels(key, catalog.models, catalog.labels, options); } catch { return []; }
}
