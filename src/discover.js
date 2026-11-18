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

