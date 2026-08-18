import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_THEME, findTheme } from './themes';

// Vault-level settings, kept in <vault>/config.json next to vault.json. Like
// everything else, this is a plain file in the vault: hand-editing it is
// legitimate, and a missing or unreadable file simply means defaults.

export const CONFIG_FILE = 'config.json';

export interface CiConfig {
  /** How many completed runs to keep per repository. */
  runs: number;
  /** Also drop completed runs older than this many days; 0 disables. */
  days: number;
  /** Largest artifact a job may upload, in megabytes. */
  artifactMb: number;
}

export interface VaultConfig {
  theme: string;
  ci: CiConfig;
}

export function configFilePath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

const DEFAULTS: VaultConfig = { theme: DEFAULT_THEME, ci: { runs: 100, days: 0, artifactMb: 500 } };

let cache: { file: string; mtimeMs: number; size: number; config: VaultConfig } | null = null;

export function loadConfig(root: string): VaultConfig {
  const file = configFilePath(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache = null;
    return { ...DEFAULTS };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.config;
  }
  let config: VaultConfig = { ...DEFAULTS, ci: { ...DEFAULTS.ci } };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    // An unknown theme name falls back to the default rather than failing the
    // request: a typo in config.json should not take the vault down.
    if (typeof parsed.theme === 'string' && findTheme(parsed.theme)) config.theme = parsed.theme;
    // Run retention: a vault's run history is the one part of its state that
    // grows without bound, so it is bounded by default and tunable here.
    if (typeof parsed.ci === 'object' && parsed.ci !== null) {
      const ci = parsed.ci as Record<string, unknown>;
      const runs = typeof ci.runs === 'number' && ci.runs >= 0 ? Math.floor(ci.runs) : DEFAULTS.ci.runs;
      const days = typeof ci.days === 'number' && ci.days >= 0 ? Math.floor(ci.days) : DEFAULTS.ci.days;
      const artifactMb =
        typeof ci.artifactMb === 'number' && ci.artifactMb > 0 ? Math.floor(ci.artifactMb) : DEFAULTS.ci.artifactMb;
      config.ci = { runs, days, artifactMb };
    }
  } catch {
    config = { ...DEFAULTS, ci: { ...DEFAULTS.ci } };
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, config };
  return config;
}

export function saveConfig(root: string, changes: Partial<VaultConfig>): VaultConfig {
  const next: VaultConfig = { ...loadConfig(root), ...changes };
  const file = configFilePath(root);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cache = null;
  return next;
}
