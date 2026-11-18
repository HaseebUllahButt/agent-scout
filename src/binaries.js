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

