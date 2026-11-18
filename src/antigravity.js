// Google's official Antigravity ACP agent - the managed runtime.
//
// The agent is not on any package registry and has no installer command of
// its own; Google ships a zip per platform on dl.google.com (the same
// archive the ACP registry lists). A manager unpacks the executable pair
// under <tools>/antigravity-acp/versions/<release>/ and points a `current`
// symlink at it; Helm, where this code comes from, uses
// ~/.helm/tools/antigravity-acp. agent-scout only looks: it never downloads
// or runs this agent.
//
// Binary facts verified against Google's release metadata (the ACP
// registry's antigravity-acp/agent.json), 2026-09.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from './paths.js';

export const ANTIGRAVITY_RELEASE = 'agy_acp_server_1.1.1';

// Only what is needed to recognise an install: the executable and the
// harness that must sit next to it.
const ASSETS = {
  'darwin-arm64': { exe: 'agy_acp_server.par', harness: 'localharness_external' },
  'linux-x64': { exe: 'agy_acp_server.par', harness: 'localharness_external' },
  'linux-arm64': { exe: 'agy_acp_server.par', harness: 'localharness_external' },
  'win32-x64': { exe: 'agy_acp_server.exe', harness: 'localharness_external.exe' },
  'win32-arm64': { exe: 'agy_acp_server.exe', harness: 'localharness_external.exe' },
};

const assetFor = (platform = process.platform, arch = process.arch) =>
  ASSETS[`${platform}-${arch}`] ?? null;

/** Where the managed agent is looked for: option, env, then Helm's folder. */
export function antigravityToolsDir({ antigravityAcpDir, env = process.env } = {}) {
  return expand(antigravityAcpDir || env.AGENT_SCOUT_ANTIGRAVITY_ACP_DIR || '~/.helm/tools/antigravity-acp');
}

/**
 * The active install: { exe, harness, version, dir } or null when the agent
 * has not been installed. `current` is a symlink to a versions/<release>
 * dir, so replacing it under a running agent only affects the next launch.
 */
export function antigravityInstall(options = {}) {
  const root = antigravityToolsDir(options);
  const dir = join(root, 'current');
  const asset = assetFor(options.platform, options.arch);
  if (!asset) return null;
  try {
    const exe = join(dir, asset.exe);
    const harness = join(dir, asset.harness);
    if (!statSync(exe).isFile() || !statSync(harness).isFile()) return null;
    let version = null;
    try { version = JSON.parse(String(readFileSync(join(root, 'active.json')))).version ?? null; } catch { /* marker gone */ }
    return { exe, harness, version, dir };
  } catch {
    return null;
  }
}
