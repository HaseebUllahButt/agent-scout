import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { delimiter, join } from 'node:path';
import { ENGINES, cliHome, engineForCommand, resolveCliId } from './engines.js';
import { antigravityInstall } from './antigravity.js';
import { findBinary, isShim, readVersion } from './binaries.js';
import { HOME, expand, collapse } from './paths.js';

const exec = promisify(execFile);

// Values that look like credentials are never reported; we keep the
// variable NAME and leave the value where it already lives.
const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|bd_live_|xox[baprs]-)/;

export const looksSecret = (name, value) =>
  SECRET_NAME.test(name) || SECRET_VALUE.test(String(value ?? ''));

const TAG = 'agent-scout-which';
const PATH_TAG = 'agent-scout-path';

// ---------------------------------------------------------------- binaries

/**
 * Where each of several commands lives, asked of one login shell. A shell
 * per name meant hundreds of login shells for a shell with many aliases:
 * eight seconds and as much CPU on every start and every rediscovery.
 * The login shell's own PATH comes back too, so a launcher it finds first
 * can be looked behind.
 */
async function whichAll(bins, env = process.env) {
  const names = [...new Set(bins.filter(Boolean))];
  const found = new Map();
  let path = '';
  if (!names.length) return { found, path };
  try {
    // Tagged, so whatever the login scripts print cannot shift the answers.
    const script = `for b do printf "${TAG}\\t%s\\t%s\\n" "$b" "$(command -v -- "$b")"; done; printf "${PATH_TAG}\\t%s\\n" "$PATH"`;
    const { stdout } = await exec('sh', ['-lc', script, 'sh', ...names], { maxBuffer: 4 << 20, timeout: 15_000, env });
    for (const line of stdout.split('\n')) {
      const [tag, name, value] = line.split('\t');
      if (tag === TAG && value?.trim()) found.set(name, value.trim());
      if (tag === PATH_TAG && name) path = name.trim();
    }
  } catch { /* no shell to ask: nothing found */ }
  return { found, path };
}

const joinPaths = (...lists) => {
  const out = [];
  for (const list of lists) {
    for (const d of String(list ?? '').split(delimiter)) if (d && !out.includes(d)) out.push(d);
  }
  return out.join(delimiter);
};

/**
 * whichAll, then the owner's terminal PATH for what the login shell missed.
 * Many installers (opencode's among them) add their folder in ~/.bashrc
 * only, which a login shell never reads. `far` holds every tool the PATH
 * this process started with cannot reach: it keeps its full path, so a
 * caller can still start it.
 */
async function locate(bins, termPath = '', env = process.env) {
  const { found: which, path: loginPath } = await whichAll(bins, env);
  const search = joinPaths(env.PATH, loginPath, termPath);
  const found = new Map();
  const far = new Map();
  for (const bin of new Set(bins.filter(Boolean))) {
    let path = which.get(bin);
    // A launcher that only forwards to the tool (or an alias/function the
    // shell printed instead of a path) is not where the tool lives.
    if (!path?.startsWith('/') || isShim(path)) path = findBinary([bin], { PATH: search })?.path ?? null;
    if (!path) continue;
    found.set(bin, path);
    if (!findBinary([bin], { PATH: env.PATH ?? '' })) far.set(bin, path);
  }
  return { found, far };
}

/**
 * Find alternate home directories for a CLI - `~/.codex-personal` next to
 * `~/.codex`, and so on. These are how a machine's extra accounts are kept
 * apart, so each one we find is a candidate account.
 */
function altHomes(engine) {
  if (!engine.defaultHome) return [];
  const base = expand(engine.defaultHome);
  const name = base.split('/').pop();
  const parent = base.slice(0, -name.length - 1) || HOME;
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(parent, d.name))
      .filter((p) => p !== base && p.split('/').pop().startsWith(name + '-'))
      .map((p) => collapse(p));
  } catch {
    return [];
  }
}

// ------------------------------------------------------- shell symbol table

/**
 * Ask the user's own shell what its aliases and functions actually are, and
 * which PATH its terminal has.
 *
 * Parsing rc files with regexes gets this wrong in practice - adjacent-quote
 * concatenation, conditionals, sourced fragments. An interactive shell has
 * already resolved all of that, and prints definitions back in a normalised,
 * re-quotable form. AGENT_SCOUT_DISCOVERY=1 lets an rc file skip anything
 * slow or noisy for this one look.
 */
export async function shellSymbols({ functions = true, env = process.env } = {}) {
  const symbols = new Map();
  let path = '';
  const run = async (args) => {
    try {
      const { stdout } = await exec('bash', args, {
        timeout: 8000,
        maxBuffer: 4 << 20,
        env: { ...env, AGENT_SCOUT_DISCOVERY: '1' },
      });
      return stdout;
    } catch (err) {
      return err?.stdout || '';
    }
  };

  // The terminal's PATH comes along: it is where the owner's tools are.
  for (const line of (await run(['-ic', `alias; printf "\\n${PATH_TAG}\\t%s\\n" "$PATH"`])).split('\n')) {
    if (line.startsWith(`${PATH_TAG}\t`)) { path = line.slice(PATH_TAG.length + 1).trim(); continue; }
    const m = /^alias\s+([^=]+)=(.*)$/.exec(line.trim());
    if (m) symbols.set(m[1], { kind: 'alias', body: unquote(m[2]) });
  }
  if (!functions) return { symbols, path };

  // One call for every function body: an alias may point at a function that
  // points at another function, so we need the whole table, not a filtered one.
  const dump = await run(['-ic', 'declare -f']);
  for (const chunk of dump.split(/\n(?=[A-Za-z_][A-Za-z0-9_:.-]*\s*\(\)\s*$)/m)) {
    const name = /^([A-Za-z_][A-Za-z0-9_:.-]*)\s*\(\)/.exec(chunk.trim())?.[1];
    if (name && !symbols.has(name)) symbols.set(name, { kind: 'function', body: chunk });
  }
  return { symbols, path };
}

/** Strip one layer of shell quoting, honouring bash's '\'' escape form. */
function unquote(s) {
  const t = s.trim();
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** Split a command string into tokens, keeping quoted runs together. */
function tokenize(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let touched = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; touched = true; continue; }
    if (/\s/.test(c)) {
      if (cur || touched) { out.push(cur); cur = ''; touched = false; }
      continue;
    }
    cur += c;
  }
  if (cur || touched) out.push(cur);
  return out;
}

/**
 * The last command in a `a && b`, `a; b` or `a || b` chain, quotes respected.
 * An alias like `clear && claude --permission-mode auto` is about claude; the
 * clear is just tidying up first.
 */
function lastCommand(s) {
  const segments = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if ((c === '&' || c === '|') && s[i + 1] === c) { segments.push(cur); cur = ''; i++; continue; }
    if (c === ';') { segments.push(cur); cur = ''; continue; }
    cur += c;
  }
  segments.push(cur);
  const real = segments.map((x) => x.trim()).filter(Boolean);
  return real[real.length - 1] ?? s;
}

/** Peel leading `VAR=value` assignments off a token list. */
function splitAssignments(tokens) {
  const env = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(tokens[i]);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return { env, argv: tokens.slice(i) };
}

/** Reduce a function body to the same {env, argv} shape as an alias. */
function parseFunction(body) {
  const env = {};
  const unset = [];
  let argv = null;
  for (let raw of body.split('\n')) {
    const trimmed = raw.trim();
    // Drop the `name ()` header before anything else - stripping grouping
    // parens first would turn it into a bogus command.
    if (!trimmed || trimmed === '{' || trimmed === '}') continue;
    if (/^[A-Za-z_][A-Za-z0-9_:.-]*\s*\(\)\s*$/.test(trimmed)) continue;

    // Bodies routinely wrap themselves in a subshell so exports do not leak;
    // the grouping parens carry no meaning for us.
    const line = trimmed
      .replace(/^[({]\s*/, '')
      .replace(/\s*[)}]+$/, '')
      .replace(/;$/, '')
      .trim();
    if (!line) continue;

    const cleared = /^unset\s+(.+)$/.exec(line);
    if (cleared) { unset.push(...tokenize(cleared[1])); continue; }

    const assign = /^(?:export\s+|local\s+|declare\s+-x\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (assign) { env[assign[1]] = unquote(assign[2]); continue; }

    if (argv) continue; // first real command wins; ignore trailing cleanup
    let tokens = tokenize(line).filter((t) => t !== '$@' && t !== '$*');
    while (tokens[0] === 'command' || tokens[0] === 'exec' || tokens[0] === 'builtin') {
      tokens = tokens.slice(1);
    }
    const split = splitAssignments(tokens);
    Object.assign(env, split.env);
    if (split.argv.length) argv = split.argv;
  }
  return { env, unset, argv: argv || [] };
}

/**
 * Follow an alias through however many other aliases and functions it points
 * at until we reach a real binary, merging env and arguments on the way.
 * `d` -> `codexpx` -> `codexp --yolo` -> `CODEX_HOME=... codex --yolo`.
 */
function resolve(name, symbols, depth = 0, seen = new Set()) {
  if (depth > 6 || seen.has(name)) return null;
  seen.add(name);
  const sym = symbols.get(name);
  if (!sym) return null;

  const parsed =
    sym.kind === 'function'
      ? parseFunction(sym.body)
      : splitAssignments(tokenize(lastCommand(sym.body)));
  if (!parsed.argv.length) return null;

  const [head, ...rest] = parsed.argv;
  const inner = resolve(head, symbols, depth + 1, seen);
  if (!inner) return { env: parsed.env, unset: parsed.unset || [], argv: parsed.argv };

  // The outer definition's env wins: it is the more specific one.
  return {
    env: { ...inner.env, ...parsed.env },
    unset: [...(inner.unset || []), ...(parsed.unset || [])],
    argv: [...inner.argv, ...rest],
  };
}

// ------------------------------------------------------------ wrapper scripts

/**
 * The CLI a wrapper script launches, or null. People keep extra accounts
 * behind scripts as well as aliases - `a1='agy-profile 1'`, where agy-profile
 * points HOME at ~/.config/google-cli-profiles/agy-1 and then `exec`s agy.
 * Nothing about that is visible from the alias, so read the script: when it
 * ends by exec-ing a CLI's binary, the alias is an account of that CLI,
 * run through the script. Variables the script assigns are substituted so
 * `exec "$agy_bin" "$@"` still names agy.
 */
export function wrappedEngine(path) {
  let text;
  try {
    if (!statSync(path).isFile() || statSync(path).size > 64 << 10) return null;
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('#!')) return null;

  const vars = { HOME };
  const sub = (s) => s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::?[-=?][^}]*)?\}?/g, (m, name) => vars[name] ?? m);
  let engine = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const assign = /^(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (assign) {
      const value = tokenize(assign[2])[0];
      if (value !== undefined) vars[assign[1]] = sub(value);
      continue;
    }
    const run = /^exec\s+(.*)$/.exec(line);
    if (!run) continue;
    let argv = splitAssignments(tokenize(run[1])).argv;
    // `exec env VAR=x agy` runs agy just the same.
    if (argv[0] === 'env') argv = splitAssignments(argv.slice(1).filter((t) => !t.startsWith('-'))).argv;
    if (argv.length) engine = engineForCommand(sub(argv[0])) ?? engine;
  }
  return engine;
}

// --------------------------------------------------------------- public API

const wanted = (ids) => {
  if (!ids) return Object.keys(ENGINES);
  const list = (Array.isArray(ids) ? ids : String(ids).split(',')).map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const name of list) {
    const id = resolveCliId(name);
    if (!id) throw new Error(`unknown CLI: ${name} (known: ${Object.keys(ENGINES).join(', ')})`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
};

/** The CLI ids `ids` names (comma list or array, aliases allowed), in table order. */
export const selectClis = (ids) => {
  const chosen = wanted(ids);
  return Object.keys(ENGINES).filter((id) => chosen.includes(id));
};

/**
 * Which coding-agent CLIs are on this machine.
 *
 * options
 *   clis       ids to look for (array or "codex,claude"); default all
 *   env        the environment to look in (default process.env)
 *   path       a PATH to search instead of asking the shells (tests, sandboxes)
 *   shell      false (or AGENT_SCOUT_NO_SHELL=1) skips the login and
 *              interactive shells: only env.PATH is searched
 *   version    false skips `--version`
 *   homes      { [cliId]: home } to override each CLI's account home
 *
 * Every requested CLI is returned, installed or not.
 */
export async function findClis(options = {}) {
  const env = options.env ?? process.env;
  const ids = selectClis(options.clis);
  const engines = ids.map((id) => ENGINES[id]);
  const bins = engines.flatMap((e) => (e.managed || !e.bin ? [] : [e.bin, ...(e.altBins ?? [])]));

  let found = new Map();
  let far = new Map();
  let termPath = '';
  if (typeof options.path === 'string') {
    for (const bin of bins) {
      const hit = findBinary([bin], { PATH: options.path });
      if (hit) found.set(bin, hit.path);
      if (hit && !findBinary([bin], { PATH: env.PATH ?? '' })) far.set(bin, hit.path);
    }
    termPath = options.path;
  } else if (options.shell === false || env.AGENT_SCOUT_NO_SHELL === '1') {
    for (const bin of bins) {
      const hit = findBinary([bin], { PATH: env.PATH ?? '' });
      if (hit) found.set(bin, hit.path);
    }
  } else {
    termPath = (await shellSymbols({ functions: false, env })).path;
    ({ found, far } = await locate(bins, termPath, env));
  }

  const out = await Promise.all(engines.map(async (e) => {
    const base = {
      id: e.id,
      label: e.label,
      aliases: e.aliases ?? [],
      bin: e.bin ?? null,
      installed: false,
      path: null,
      realPath: null,
      onPath: false,
      version: null,
      home: expand(cliHome(e.id, { homes: options.homes, env })),
      managed: !!e.managed,
    };
    if (e.managed) {
      // A managed CLI ships no PATH binary; it is "installed" when its
      // unpacked runtime is in place (Antigravity's ACP agent).
      const install = antigravityInstall({ ...options, env });
      if (!install) return base;
      return { ...base, installed: true, path: install.exe, realPath: install.exe, version: install.version };
    }
    let hit = null;
    for (const bin of [e.bin, ...(e.altBins ?? [])]) {
      const path = found.get(bin);
      if (path) { hit = { bin, path }; break; }
    }
    if (!hit) return base;
    let realPath = hit.path;
    try { realPath = realpathSync(hit.path); } catch { /* keep the link path */ }
    const version = options.version === false ? null : await readVersion(hit.path, { env }).catch(() => null);
    return {
      ...base, bin: hit.bin, installed: true, path: hit.path, realPath,
      onPath: !far.has(hit.bin), version,
    };
  }));
  // The terminal PATH is handy for callers that start these CLIs later.
  Object.defineProperty(out, 'searchPath', { value: joinPaths(env.PATH, termPath), enumerable: false });
  return out;
}

/**
 * Accounts on this machine: each installed CLI's default home, sibling
 * homes (`~/.codex-work` next to `~/.codex`), and the owner's shell aliases,
 * functions and wrapper scripts that launch a CLI. Secret-looking variables
 * are reported by name only (`secretEnv`), never by value.
 */
export async function findAccounts(options = {}) {
  const env = options.env ?? process.env;
  const shell = options.symbols ? { symbols: options.symbols, path: options.path ?? '' } : await shellSymbols({ env });
  const clis = options.installedClis ?? await findClis({ ...options, version: false });
  const installed = Object.fromEntries(clis.filter((c) => c.installed).map((c) => [c.id, c.path]));
  const far = new Map(clis.filter((c) => c.installed && !c.onPath && c.bin).map((c) => [c.bin, c.path]));

  const accounts = [];
  const byKey = new Map();
  const add = (a) => {
    const key = [a.cmd, (a.args || []).join(' '), JSON.stringify(a.env || {}), (a.secretEnv || []).join(','), (a.unset || []).join(',')].join('|');
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, a); accounts.push(a); return; }
    // Same invocation reached two ways. A name the user chose themselves is
    // more meaningful than one we synthesised from a directory listing.
    if (a.source === 'alias' && existing.source === 'detected') {
      existing.id = a.id;
      existing.label = a.label;
      existing.source = 'alias';
    } else if (a.source === 'alias' && existing.source === 'alias') {
      // Preserve the names people use even when two aliases launch alike.
      accounts.push(a);
    }
  };

  for (const cli of clis) {
    if (!cli.installed) continue;
    const e = ENGINES[cli.id];
    const cmd = cli.onPath ? cli.bin : collapse(cli.path);
    add({ id: e.id, label: e.label, cli: e.id, cmd, args: [], env: {}, secretEnv: [], unset: [], source: 'detected' });
    // Extra accounts, inferred from sibling home directories. Only a CLI
    // with an env-isolated home can run a second account this way; without
    // one there is no variable to point at the sibling directory.
    for (const home of e.homeEnv && !e.managed ? altHomes(e) : []) {
      const suffix = home.split('/').pop().split('-').slice(1).join('-');
      add({
        id: `${e.id}-${suffix}`, label: `${e.label} · ${suffix}`, cli: e.id, cmd, args: [],
        env: { [e.homeEnv]: home }, secretEnv: [], unset: [], source: 'detected',
      });
    }
  }

  const aliases = await discoverAliasAccounts(shell.symbols, installed, { termPath: shell.path, far, env });
  for (const a of aliases) add(a);
  return accounts;
}

/** Accounts the owner's aliases and functions encode; secrets stay names only. */
export async function discoverAliasAccounts(symbols, installed, { termPath = '', far = new Map(), env = process.env } = {}) {
  const accounts = [];
  const all = [...symbols.keys()].map((name) => [name, resolve(name, symbols)]).filter(([, resolved]) => resolved);
  // Not a CLI itself: maybe a script that launches one. Every bare
  // command name is looked up at once.
  const { found: where } = await locate(all.map(([, resolved]) => resolved.argv[0])
    .filter((cmd) => !engineForCommand(cmd) && !cmd.includes('/')), termPath, env);
  for (const [name, resolved] of all) {
    let engineId = engineForCommand(resolved.argv[0]);
    let wraps = null;
    if (!engineId) {
      const path = resolved.argv[0].includes('/') ? expand(resolved.argv[0]) : where.get(resolved.argv[0]) ?? null;
      engineId = path ? wrappedEngine(path) : null;
      // Keep the script's full path: the caller's PATH may not reach it.
      if (engineId) { wraps = engineId; resolved.argv[0] = collapse(path); }
    }
    if (!engineId || !installed[engineId]) continue;
    if (far.has(resolved.argv[0])) resolved.argv[0] = collapse(far.get(resolved.argv[0]));

    const vars = {};
    const secretEnv = [];
    for (const [k, v] of Object.entries(resolved.env)) {
      if (looksSecret(k, v)) secretEnv.push(k);
      else vars[k] = collapse(v.replace(/^\$HOME/, HOME));
    }

    accounts.push({
      id: name,
      label: name,
      cli: engineId,
      cmd: resolved.argv[0],
      args: resolved.argv.slice(1),
      env: vars,
      secretEnv,
      unset: resolved.unset || [],
      source: 'alias',
      // Launched through a script: anything that runs the CLI's own binary
      // for this account (listing models) has to go through it too.
      ...(wraps ? { wraps } : {}),
    });
  }
  return accounts;
}
