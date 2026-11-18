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

