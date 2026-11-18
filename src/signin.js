import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINES } from './engines.js';
import { HOME, expand } from './paths.js';
import { readState, writeState } from './state.js';
import { agyModelsFromOutput, primeModels } from './models.js';

/**
 * Whether a CLI is signed in. A signed-out CLI looks exactly like a working
 * one until its first turn fails, so each CLI that can say is asked, the way
 * the account would run it (its env, and its wrapper script if it has one).
 * The answer is one of:
 *   authenticated   - the CLI says it is signed in          (signedIn: true)
 *   unauthenticated - the CLI says it is not                 (signedIn: false)
 *   unknown         - no probe for this CLI, or it failed or timed out (null)
 * Only `unauthenticated` is a "no": a slow or odd CLI must never make a
 * working account look signed out. From Helm's auth.js.
 */

const PROBE_TIMEOUT_MS = 20_000;
const TTL_MS = 10 * 60_000;
const FILE = 'signin.json';

/** cli -> { args, read(stdout, stderr, code), prime? } */
const PROBES = {
  claude: {
    args: ['auth', 'status', '--json'],
    read(out) {
      try {
        const parsed = JSON.parse(out);
        return parsed.loggedIn === true ? 'authenticated' : parsed.loggedIn === false ? 'unauthenticated' : 'unknown';
      } catch {
        return /not logged in/i.test(out) ? 'unauthenticated' : 'unknown';
      }
    },
  },
  codex: {
    args: ['login', 'status'],
    read(out, err, code) {
      const text = `${out}\n${err}`;
      if (/not logged in/i.test(text)) return 'unauthenticated';
      return code === 0 && /logged in/i.test(text) ? 'authenticated' : 'unknown';
    },
  },
  antigravity: {
    // Signed out, agy refuses to list models and says so. Signed in, the
    // answer *is* the model list - which costs agy the same several seconds
    // to fetch, so it is handed to models.js below.
    args: ['models'],
    read(out, err) {
      const text = `${out}\n${err}`;
      if (/sign in/i.test(text)) return 'unauthenticated';
      return /^\S+\t/m.test(out) ? 'authenticated' : 'unknown';
    },
    prime({ home, launcher, options }, out) {
      const value = agyModelsFromOutput(expand(home), out);
      if (value.models.length) primeModels('antigravity', home, launcher, value, options);
    },
  },
};

/** The CLIs that can say whether they are signed in. */
export const SIGNIN_CLIS = Object.keys(PROBES);

const run = (cmd, args, env) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 1 << 20,
        env,
      }, (error, stdout, stderr) => {
        if (error?.killed || error?.code === 'ENOENT') return resolve(null);
        resolve({ out: String(stdout ?? ''), err: String(stderr ?? ''), code: error ? (error.code ?? 1) : 0 });
      });
    } catch { resolve(null); }
  });

const homeOf = (cli, options) => options.home ?? (ENGINES[cli]?.homeEnv && (options.env ?? process.env)[ENGINES[cli].homeEnv]) ?? ENGINES[cli]?.defaultHome ?? '~';

function spawnEnv(cli, options) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const e = ENGINES[cli];
  // Only point the CLI somewhere else when asked for another account: some
  // CLIs behave differently with their variable set to the default folder
  // (Claude Code then looks for .claude.json inside ~/.claude).
  if (options.home && e?.homeEnv && expand(options.home) !== expand(env[e.homeEnv] || e.defaultHome)) {
    env[e.homeEnv] = expand(options.home);
  }
  return env;
}

/**
 * Ask one CLI: 'authenticated' | 'unauthenticated' | 'unknown'.
 *
 * options: bin (program, default the CLI's name on PATH), launcher
 * ({cmd, args} of a wrapper script), home, env.
 */
export async function probeSignIn(cli, options = {}) {
  const probe = PROBES[cli];
  if (!probe) return 'unknown';
  // A wrapper script needs its own arguments (`agy-profile 1`).
  const cmd = options.launcher ? expand(options.launcher.cmd) : options.bin ?? ENGINES[cli]?.bin ?? cli;
  const lead = options.launcher?.args ?? [];
  const result = await run(cmd, [...lead, ...probe.args], spawnEnv(cli, options));
  if (!result) return 'unknown';
  const status = probe.read(result.out, result.err, result.code);
  if (status === 'authenticated') {
    try { probe.prime?.({ home: homeOf(cli, options), launcher: options.launcher ?? null, options }, result.out); } catch { /* only a shortcut */ }
  }
  return status;
}

// A sign-in changes this file without changing anything else. Recheck
// immediately instead of reporting a newly signed-in account as signed out
// for ten minutes.
function loginStamp(cli, options) {
  if (cli !== 'codex') return null;
  const env = spawnEnv(cli, options);
  const home = env.CODEX_HOME;
  const path = join(home ? expand(home) : join(env.HOME || HOME, '.codex'), 'auth.json');
  try {
    const s = statSync(path);
    return JSON.stringify([path, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
  } catch { return JSON.stringify([path, 'missing']); }
}

const keyOf = (cli, options) => JSON.stringify([cli, options.launcher ? [options.launcher.cmd, ...(options.launcher.args ?? [])] : options.bin ?? null,
  expand(homeOf(cli, options))]);

const toBool = (status) => (status === 'authenticated' ? true : status === 'unauthenticated' ? false : null);

/**
 * Whether one CLI account is signed in: true, false, or null when it cannot
 * be known. Answers are kept in the state folder for ten minutes, so a
 * second scan does not spend another round of five-second probes; `refresh`
 * asks again, and a Codex sign-in or sign-out is noticed at once.
 */
export async function checkSignedIn(cli, options = {}) {
  if (!PROBES[cli]) return null;
  const useCache = options.cache !== false;
  const key = keyOf(cli, options);
  const stamp = loginStamp(cli, options);
  const saved = useCache ? readState(FILE, options, {}).answers ?? {} : {};
  const hit = saved[key];
  if (!options.refresh && hit && typeof hit.status === 'string' && hit.stamp === stamp && Date.now() - hit.at < TTL_MS) {
    return toBool(hit.status);
  }
  const status = await probeSignIn(cli, options).catch(() => 'unknown');
  if (useCache) {
    // Read again: other CLIs were probed at the same time.
    const answers = readState(FILE, options, {}).answers ?? {};
    for (const [k, v] of Object.entries(answers)) if (!v || Date.now() - v.at > 7 * 24 * 60 * 60_000) delete answers[k];
    answers[key] = { status, at: Date.now(), stamp };
    writeState(FILE, { answers }, options);
  }
  return toBool(status);
}
