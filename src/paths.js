import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const HOME = homedir();

/** Expand a leading ~ so paths can stay portable between machines. */
export const expand = (p, home = HOME) =>
  typeof p === 'string' && p.startsWith('~')
    ? join(home, p.slice(1))
    : p;

/** Collapse an absolute path back to ~ form for display. */
export const collapse = (p, home = HOME) => {
  if (typeof p !== 'string' || !p) return p;
  if (p.startsWith('~')) return p;          // already collapsed
  if (!p.startsWith('/')) return p;         // not a path at all
  const abs = resolve(p);
  return abs === home || abs.startsWith(home + '/') ? '~' + abs.slice(home.length) : abs;
};

/**
 * Where agent-scout keeps what it must remember between runs (models already
 * seen, the last model lists, sign-in answers). In order: the `stateDir`
 * option, $AGENT_SCOUT_STATE_DIR, $XDG_STATE_HOME/agent-scout, and
 * ~/.local/state/agent-scout.
 */
export function stateDir(options = {}, env = process.env) {
  if (typeof options.stateDir === 'string' && options.stateDir) return resolve(expand(options.stateDir));
  if (env.AGENT_SCOUT_STATE_DIR) return resolve(expand(env.AGENT_SCOUT_STATE_DIR));
  if (env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith('/')) return join(env.XDG_STATE_HOME, 'agent-scout');
  return join(HOME, '.local', 'state', 'agent-scout');
}
