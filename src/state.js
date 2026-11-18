import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './paths.js';

/**
 * One small JSON file per concern inside the state folder. Reads never throw
 * (a missing or broken file is an empty one) and writes go through a temp
 * file and a rename, so a killed process never leaves half a file behind.
 */
export function stateFile(name, options = {}) {
  return join(stateDir(options), name);
}

export function readState(name, options = {}, fallback = {}) {
  try {
    const value = JSON.parse(readFileSync(stateFile(name, options), 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeState(name, value, options = {}) {
  const file = stateFile(name, options);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...value }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    if (options.log) options.log(`[agent-scout] could not save ${name}: ${err?.message || err}`);
    return false;
  }
}
