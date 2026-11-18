// What agent-scout knows about each coding-agent CLI.
//
// `homeEnv` is the variable that isolates one account from another: point it
// at a different directory and the CLI is a different user. agent-scout reads
// each CLI's own files from that home (its saved default model, its model
// caches), so `CLAUDE_CONFIG_DIR=~/.claude-work agent-scout scan` reports the
// work account.
//
// `aliases` are other names the same CLI goes by. The Antigravity CLI ships
// as `agy` (and Helm, where this table comes from, calls it that), so `agy`
// resolves to `antigravity` everywhere an id is accepted.

export const ENGINES = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    defaultHome: '~/.claude',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    homeEnv: 'CODEX_HOME',
    defaultHome: '~/.codex',
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    // opencode keys off XDG rather than a dedicated variable, so isolating an
    // account means moving the whole XDG config root.
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
    configPath: 'opencode/opencode.json',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity CLI',
    bin: 'agy',
    aliases: ['agy'],
    // agy's store sits inside the gemini home: <GEMINI_CLI_HOME>/antigravity-cli.
    // A second account is the same variable a second gemini account uses.
    homeEnv: 'GEMINI_CLI_HOME',
    defaultHome: '~/.gemini',
  },
  opencode2: {
    id: 'opencode2',
    label: 'OpenCode 2',
    bin: 'opencode2',
    // V2 deliberately shares provider credentials and configuration with V1,
    // but keeps its own session schema inside the shared data database.
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
    configPath: 'opencode/opencode.jsonc',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    bin: 'gemini',
    homeEnv: 'GEMINI_CLI_HOME',
    defaultHome: '~/.gemini',
  },
  devin: {
    id: 'devin',
    label: 'Devin',
    bin: 'devin',
    // Same XDG caveat as opencode: config lives in ~/.config/devin, the login
    // in ~/.local/share/devin.
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
    configPath: 'devin/config.json',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    homeEnv: 'GROK_HOME',
    defaultHome: '~/.grok',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    // The stable launcher; older installs shipped the same binary as `agent`.
    bin: 'cursor-agent',
    altBins: ['agent'],
    defaultHome: '~/.cursor',
  },
  vibe: {
    id: 'vibe',
    label: 'Mistral Vibe',
    bin: 'vibe',
    // VIBE_HOME moves the whole of ~/.vibe: config.toml, the .env that holds
    // the Mistral key, and logs/session/ where chats are saved.
    homeEnv: 'VIBE_HOME',
    defaultHome: '~/.vibe',
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    bin: 'pi',
    homeEnv: 'PI_CODING_AGENT_DIR',
    defaultHome: '~/.pi/agent',
  },
  omp: {
    id: 'omp',
    label: 'OMP',
    bin: 'omp',
    // OMP has no home env var of its own; `--profile <name>` is how a second
    // account isolates auth, sessions and settings.
    defaultHome: '~/.omp/agent',
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    bin: 'kimi',
    defaultHome: '~/.kimi-code',
  },
  muse: {
    id: 'muse',
    label: 'Muse',
    bin: 'muse',
    // muse keys off XDG like opencode: ~/.config/muse for config, data under
    // ~/.local/share/muse.
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
  },
  'antigravity-acp': {
    id: 'antigravity-acp',
    label: 'Antigravity ACP agent',
    // Google's official ACP agent: not on PATH, never a TUI. It is a zip
    // Google ships per platform, unpacked by a manager (Helm puts it in
    // ~/.helm/tools/antigravity-acp). See antigravity.js for where it is
    // looked for. It has no model-list command.
    managed: true,
    homeEnv: 'GEMINI_HOME',
    defaultHome: '~/.gemini',
  },
};

/** Every CLI id, in the order agent-scout reports them. */
export const CLI_IDS = Object.keys(ENGINES);

/** A CLI id or one of its aliases (`agy`) as the id, or null if unknown. */
export function resolveCliId(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const want = name.trim().toLowerCase();
  if (ENGINES[want]) return want;
  for (const e of Object.values(ENGINES)) {
    if ((e.aliases ?? []).includes(want)) return e.id;
  }
  return null;
}

/** Map a resolved argv[0] back to a CLI id, or null if we don't know it. */
export function engineForCommand(cmd) {
  if (!cmd) return null;
  const base = cmd.split('/').pop();
  for (const e of Object.values(ENGINES)) {
    const names = [e.bin, ...(e.altBins ?? [])].filter(Boolean);
    if (names.some((n) => base === n || base.startsWith(n + '.'))) return e.id;
  }
  return null;
}

/**
 * The account home a CLI reads, as the current environment would run it:
 * an explicit option first, then the CLI's own variable, then its default.
 */
export function cliHome(id, { homes = {}, env = process.env } = {}) {
  const e = ENGINES[id];
  if (!e) return null;
  return homes[id] ?? (e.homeEnv && env[e.homeEnv]) ?? e.defaultHome ?? '~';
}
