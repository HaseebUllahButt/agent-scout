import { execFile } from 'node:child_process';
import { accessSync, constants, createReadStream, lstatSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, relative, isAbsolute } from 'node:path';
import { HOME } from './paths.js';

/**
 * Finding a CLI's real program, reading its version, and telling how it was
 * installed. From Helm's cli-updates.js, minus the part that runs updates:
 * agent-scout only looks.
 */

/**
 * Launcher scripts that sit first on PATH and only forward to the real tool.
 * Helm writes one per CLI (in ~/.helm/bin) with this marker; reading the
 * shim's version or size would describe the shim, not the tool.
 */
const SHIM_MARKERS = ['# Helm native CLI integration'];

export const VERSION_TIMEOUT_MS = 10_000;

/**
 * How each tool can be brought up to date.
 *   self  the tool's own update command, checked with its --help
 *   npm   the npm packages it ships as; only trusted when the real file sits
 *         inside a folder of that exact package under `npm root -g`
 * A tool with neither (kimi, muse, ...) is only ever reported.
 * Pi's own `update` refreshes its add-ons, not pi, so pi goes through npm.
 *   curl  the self command for a copy the install script put in ~/.opencode/bin;
 *         OpenCode cannot always tell that by itself ("Pass --method")
 */
export const UPDATERS = {
  claude: { self: ['update'], npm: ['@anthropic-ai/claude-code'] },
  codex: { self: ['update'], npm: ['@openai/codex'] },
  opencode: { self: ['upgrade'], curl: ['upgrade', '--method', 'curl'], npm: ['opencode-ai'] },
  opencode2: { self: ['upgrade'], curl: ['upgrade', '--method', 'curl'] },
  devin: { self: ['update'] },
  grok: { self: ['update'] },
  cursor: { self: ['update'] },
  antigravity: { self: ['update'] },
  gemini: { npm: ['@google/gemini-cli'] },
  pi: { npm: ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'] },
};

/** A smaller file is a launcher script, not the program, so it can not say which models it knows. */
export const PROGRAM_MIN_BYTES = 5 << 20;

/**
 * The ids that the program file does not contain, read in pieces so a large
 * program never sits in memory. Null when the file is a launcher script.
 */
export async function missingModels(file, ids) {
  if (!ids?.length) return [];
  let size = 0;
  try { size = statSync(file).size; } catch { return null; }
  if (size < PROGRAM_MIN_BYTES) return null;
  const left = new Set(ids);
  const keep = Math.max(...ids.map((id) => id.length));
  let tail = '';
  for await (const chunk of createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 20 })) {
    const text = tail + chunk;
    for (const id of left) if (text.includes(id)) left.delete(id);
    if (!left.size) return [];
    tail = text.slice(-keep);
  }
  return [...left];
}

// ------------------------------------------------------------ small helpers

const slash = (p) => String(p).replaceAll('\\', '/');
export const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** First version-looking token of `tool --version` ("codex-cli 0.161.0", "2026.08.11-e8db854"). */
export function parseVersion(text) {
  const m = stripAnsi(text).match(/\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?/);
  return m ? m[0] : null;
}

/** Is `latest` ahead of `have`? Numbers only; anything unreadable says no. */
export function isNewer(latest, have) {
  if (!latest || !have) return false;
  const nums = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  const a = nums(latest), b = nums(have);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

const writable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };

const packageName = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name ?? null; } catch { return null; }
};

/** A forwarding launcher (see SHIM_MARKERS), never the tool itself. */
export const isShim = (path) => {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size >= 16_384) return false;
    const text = readFileSync(path, 'utf8');
    return SHIM_MARKERS.some((m) => text.includes(m));
  } catch { return false; }
};

/**
 * The real program behind a command name. Launcher scripts are skipped on
 * purpose - they only forward to the tool, and the tool is what gets its
 * version read. `skipDirs` are folders never to look in.
 */
export function findBinary(names, { PATH = process.env.PATH ?? '', platform = process.platform, skipDirs = [] } = {}) {
  const exts = platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';').filter(Boolean)] : [''];
  for (const bin of names) {
    for (const dir of PATH.split(platform === 'win32' ? ';' : delimiter)) {
      if (!dir || skipDirs.includes(dir)) continue;
      for (const ext of exts) {
        const path = join(dir, bin + ext);
        try {
          if (!statSync(path).isFile()) continue;
          accessSync(path, constants.X_OK);
          if (isShim(path)) continue;
          return { bin, path };
        } catch { /* not here */ }
      }
    }
  }
  return null;
}

// -------------------------------------------------------------- install kind

// Places a package manager or the system owns. Updating something there is
// not ours to do, whatever the tool's own updater might try.
const OTHER_OWNERS = [
  [/\/(Cellar|homebrew|\.linuxbrew|linuxbrew)(\/|$)/i, 'homebrew', 'installed by Homebrew - update it with brew'],
  [/^\/(usr|opt|bin|sbin|snap|nix|Applications|Library|var\/lib\/flatpak)(\/|$)/, 'system', 'installed by the system - update it with the system’s package manager'],
  [/\/(Program Files|Program Files \(x86\)|WindowsApps)(\/|$)/i, 'system', 'installed by the system - update it with the system’s package manager'],
  [/\/\.bun\//, 'other', 'installed with bun - update it with bun'],
  [/\/(pnpm|\.pnpm)(\/|$)|\/\.local\/share\/pnpm\//, 'other', 'installed with pnpm - update it with pnpm'],
  [/\/\.(yarn|config\/yarn)\//, 'other', 'installed with yarn - update it with yarn'],
  [/\/(\.local\/share\/uv|\.local\/pipx|pipx)\//, 'other', 'installed with Python tooling - update it there'],
  [/\/\.cargo\//, 'other', 'installed with cargo - update it with cargo'],
];

/**
 * How `realPath` (the file after following links) was installed, and the one
 * safe command that updates it - or why none exists. Pure, so every case can
 * be tried with made-up paths. agent-scout never runs the command; it is
 * reported so the caller can.
 */
export function classifyInstall(engine, realPath, {
  npmRoot = null, home = HOME, platform = process.platform,
  canWrite = writable, pkgNameOf = packageName,
} = {}) {
  const spec = UPDATERS[engine];
  const path = slash(realPath);
  const no = (method, reason) => ({ method, canUpdate: false, reason });
  if (!spec) return no('other', 'no automatic updater is known for this tool');

  // 1. A package inside npm's own global folder, and one we recognise.
  const root = npmRoot ? slash(npmRoot) : null;
  if (root && inside(path, root)) {
    const parts = path.slice(root.length).split('/').filter(Boolean);
    const pkg = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pkgDir = join(npmRoot, ...(pkg ?? '').split('/'));
    if (!pkg || !spec.npm?.includes(pkg) || pkgNameOf(pkgDir) !== pkg) {
      return no('npm', `installed with npm as ${pkg ?? 'an unknown package'}, which agent-scout does not recognise as this tool`);
    }
    if (!canWrite(npmRoot) || !canWrite(pkgDir)) return no('npm', 'installed with npm in a folder this user can not write to');
    return { method: 'npm', canUpdate: true, pkg, command: { cmd: 'npm', args: ['install', '-g', `${pkg}@latest`] } };
  }
  // 2. Somebody else's install: never ours to change. (Checked before the
  // generic npm case so bun's and pnpm's node_modules are named correctly.)
  for (const [pattern, method, reason] of OTHER_OWNERS) {
    if (pattern.test(path)) return no(method, reason);
  }

  // 2b. npm with its own folder in this user's home (`npm i -g --prefix
  // ~/.local`), used where npm's default folder needs sudo. That same
  // folder is where the update goes.
  const own = platform === 'win32' ? null : /^(.+)\/lib\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
  // A Node version manager's folder belongs to its own Node and npm.
  const manager = /\/(\.nvm|\.fnm|\.volta|\.asdf|\.local\/share\/fnm|n\/versions)\//.test(path);
  if (own && !manager && own[1].startsWith(slash(home) + '/') && spec.npm?.includes(own[2])) {
    const pkgDir = join(own[1], 'lib', 'node_modules', ...own[2].split('/'));
    if (pkgNameOf(pkgDir) !== own[2]) return no('npm', `installed with npm as ${own[2]}, which agent-scout does not recognise as this tool`);
    if (!canWrite(join(own[1], 'lib', 'node_modules')) || !canWrite(pkgDir)) return no('npm', 'installed with npm in a folder this user can not write to');
    return { method: 'npm', canUpdate: true, pkg: own[2], command: { cmd: 'npm', args: ['install', '-g', '--prefix', own[1], `${own[2]}@latest`] } };
  }

  if (path.includes('/node_modules/')) {
    return no('npm', root
      ? 'installed with npm somewhere other than the npm agent-scout found (another Node version?)'
      : 'installed with npm, but agent-scout can not find npm');
  }

  // 3. The tool's own updater, only for a copy that lives in this user's home.
  if (spec.self) {
    const h = slash(home);
    const mine = platform === 'win32' ? path.toLowerCase().startsWith(h.toLowerCase() + '/') : path.startsWith(h + '/');
    if (!mine) return no('other', 'installed outside your home folder - update it where it was installed');
    if (!canWrite(dirname(realPath))) return no('self', 'its folder is not writable by this user');
    const curl = spec.curl && path.startsWith(`${slash(home)}/.opencode/bin/`);
    return { method: 'self', canUpdate: true, command: { cmd: null, args: curl ? spec.curl : spec.self } };
  }
  return no('other', 'no automatic updater is known for this install');
}

// ----------------------------------------------------------------- processes

/** Run a program with an argument list (never a shell string) and collect what it says. */
export function run(cmd, args, { timeout, env = process.env, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // npm is a .cmd script on Windows, which only starts through a shell.
    // Run npm's own script with node instead and no shell is involved.
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const viaNode = platform === 'win32' && cmd === 'npm';
    let child;
    try {
      child = execFile(viaNode ? process.execPath : cmd, viaNode ? [npmCli, ...args] : args,
        { timeout, env, maxBuffer: 2 << 20, windowsHide: true },
        (error, stdout, stderr) => {
          const out = stripAnsi(`${stdout ?? ''}\n${stderr ?? ''}`).split('\n').map((l) => l.trim()).filter(Boolean);
          resolve({
            ok: !error, code: error?.code ?? 0, ms: Date.now() - started, out,
            timedOut: !!error && (error.killed === true || error.signal === 'SIGTERM'),
          });
        });
    } catch (error) {
      resolve({ ok: false, code: error?.code ?? 1, ms: 0, out: [], timedOut: false });
      return;
    }
    // Tools sometimes wait for a keypress; nobody is there to give one.
    child.stdin?.end();
  });
}

/** `tool --version`, read as a version string, or null. */
export async function readVersion(path, { env = process.env, platform = process.platform, timeout = VERSION_TIMEOUT_MS } = {}) {
  const r = await run(path, ['--version'], { timeout, env, platform });
  return parseVersion(r.out.join('\n'));
}
