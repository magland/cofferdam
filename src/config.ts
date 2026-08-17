import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_THEME, findTheme } from './themes';

// Vault-level settings, kept in <vault>/config.json next to vault.json. Like
// everything else, this is a plain file in the vault: hand-editing it is
// legitimate, and a missing or unreadable file simply means defaults.

export const CONFIG_FILE = 'config.json';

export interface VaultConfig {
  theme: string;
}

export function configFilePath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

const DEFAULTS: VaultConfig = { theme: DEFAULT_THEME };

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
  let config: VaultConfig = { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    // An unknown theme name falls back to the default rather than failing the
    // request: a typo in config.json should not take the site down.
    if (typeof parsed.theme === 'string' && findTheme(parsed.theme)) config.theme = parsed.theme;
  } catch {
    config = { ...DEFAULTS };
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
