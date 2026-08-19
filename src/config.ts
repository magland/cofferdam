import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomic';
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

export interface SitesConfig {
  /**
   * Hostname whose subdomains serve repository sites, e.g.
   * "vault1-sites.magland.org". Empty means sites are served on the forge
   * host, sandboxed.
   */
  host: string;
}

export interface VaultConfig {
  theme: string;
  ci: CiConfig;
  sites: SitesConfig;
}

// A hostname of at least two labels, each of letters, digits, and interior
// hyphens. A value carrying a scheme, a port, or a single label is not one, and
// is treated as a typo rather than obeyed.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function configFilePath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

const DEFAULTS: VaultConfig = {
  theme: DEFAULT_THEME,
  ci: { runs: 100, days: 0, artifactMb: 500 },
  sites: { host: '' },
};

function defaults(): VaultConfig {
  return { ...DEFAULTS, ci: { ...DEFAULTS.ci }, sites: { ...DEFAULTS.sites } };
}

let cache: { file: string; mtimeMs: number; size: number; config: VaultConfig } | null = null;

export function loadConfig(root: string): VaultConfig {
  const file = configFilePath(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache = null;
    return defaults();
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.config;
  }
  let config: VaultConfig = defaults();
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
    // A site host lets each repository's site have an origin of its own. A
    // value that is not a plausible hostname is ignored the way an unknown
    // theme name is: a typo here would otherwise stop sites being served at
    // all, or worse, serve them from a name that is not the one the
    // certificate covers.
    if (typeof parsed.sites === 'object' && parsed.sites !== null) {
      const sites = parsed.sites as Record<string, unknown>;
      const raw = typeof sites.host === 'string' ? sites.host.trim().toLowerCase().replace(/\.$/, '') : '';
      config.sites = { host: HOSTNAME_RE.test(raw) ? raw : DEFAULTS.sites.host };
    }
  } catch {
    config = defaults();
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, config };
  return config;
}

export function saveConfig(root: string, changes: Partial<VaultConfig>): VaultConfig {
  const next: VaultConfig = { ...loadConfig(root), ...changes };
  writeFileAtomic(configFilePath(root), JSON.stringify(next, null, 2) + '\n');
  cache = null;
  return next;
}
