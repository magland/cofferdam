// What a repository is written in, as GitHub's Languages bar says it: the
// share of the source at a ref that belongs to each language, measured in
// bytes.
//
// The measurement is deliberately simple. GitHub runs Linguist, which reads
// file contents, resolves ambiguous extensions with heuristics, and consults
// .gitattributes; we look at the tree once and go by extension (or by
// filename, for the files that have none). That is a good deal cheaper — one
// `git ls-tree` and no blob reads at all, since the tree already carries every
// blob's size — and it agrees with Linguist on the ordinary repository. Where
// it cannot agree is noted at each rule below.

import { execGit } from './git';

/**
 * Linguist's classification, kept because it decides what counts: the bar
 * shows programming and markup and leaves out data and prose, which is why a
 * repository of JSON and Markdown reports no languages rather than reporting
 * itself as Markdown.
 */
type LanguageType = 'programming' | 'markup' | 'data' | 'prose';

interface LanguageDef {
  name: string;
  /** Linguist's colour for the language; the one piece of the interface a theme does not get to set. */
  color: string;
  type: LanguageType;
  /** Extensions, without the dot, lowercased. */
  ext?: string[];
  /** Whole filenames, for the languages whose files have no extension. */
  names?: string[];
}

// Names and colours are Linguist's (github-linguist/linguist, MIT), copied in
// rather than depended on, since cofferdam ships no static files. A language
// absent from this table is simply not counted, which is the same treatment
// Linguist gives a file it cannot classify.
const LANGUAGES: LanguageDef[] = [
  { name: 'TypeScript', color: '#3178c6', type: 'programming', ext: ['ts', 'mts', 'cts'] },
  { name: 'TSX', color: '#3178c6', type: 'programming', ext: ['tsx'] },
  { name: 'JavaScript', color: '#f1e05a', type: 'programming', ext: ['js', 'mjs', 'cjs', 'jsx'] },
  { name: 'Python', color: '#3572A5', type: 'programming', ext: ['py', 'pyw', 'pyi'] },
  { name: 'Ruby', color: '#701516', type: 'programming', ext: ['rb'], names: ['Rakefile', 'Gemfile'] },
  { name: 'Go', color: '#00ADD8', type: 'programming', ext: ['go'] },
  { name: 'Rust', color: '#dea584', type: 'programming', ext: ['rs'] },
  { name: 'C', color: '#555555', type: 'programming', ext: ['c', 'h'] },
  { name: 'C++', color: '#f34b7d', type: 'programming', ext: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'] },
  { name: 'C#', color: '#178600', type: 'programming', ext: ['cs'] },
  { name: 'Java', color: '#b07219', type: 'programming', ext: ['java'] },
  { name: 'Kotlin', color: '#A97BFF', type: 'programming', ext: ['kt', 'kts'] },
  { name: 'Swift', color: '#F05138', type: 'programming', ext: ['swift'] },
  { name: 'Objective-C', color: '#438eff', type: 'programming', ext: ['m', 'mm'] },
  { name: 'PHP', color: '#4F5D95', type: 'programming', ext: ['php'] },
  { name: 'Perl', color: '#0298c3', type: 'programming', ext: ['pl', 'pm'] },
  { name: 'Lua', color: '#000080', type: 'programming', ext: ['lua'] },
  { name: 'R', color: '#198CE7', type: 'programming', ext: ['r'] },
  { name: 'Julia', color: '#a270ba', type: 'programming', ext: ['jl'] },
  { name: 'MATLAB', color: '#e16737', type: 'programming', ext: ['mat'] },
  { name: 'Scala', color: '#c22d40', type: 'programming', ext: ['scala', 'sc'] },
  { name: 'Clojure', color: '#db5855', type: 'programming', ext: ['clj', 'cljs', 'cljc', 'edn'] },
  { name: 'Elixir', color: '#6e4a7e', type: 'programming', ext: ['ex', 'exs'] },
  { name: 'Erlang', color: '#B83998', type: 'programming', ext: ['erl', 'hrl'] },
  { name: 'Haskell', color: '#5e5086', type: 'programming', ext: ['hs', 'lhs'] },
  { name: 'OCaml', color: '#ef7a08', type: 'programming', ext: ['ml', 'mli'] },
  { name: 'F#', color: '#b845fc', type: 'programming', ext: ['fs', 'fsi', 'fsx'] },
  { name: 'Dart', color: '#00B4AB', type: 'programming', ext: ['dart'] },
  { name: 'Zig', color: '#ec915c', type: 'programming', ext: ['zig'] },
  { name: 'Nim', color: '#ffc200', type: 'programming', ext: ['nim', 'nims'] },
  { name: 'Crystal', color: '#000100', type: 'programming', ext: ['cr'] },
  { name: 'D', color: '#ba595e', type: 'programming', ext: ['d'] },
  { name: 'Groovy', color: '#4298b8', type: 'programming', ext: ['groovy', 'gradle'] },
  { name: 'Fortran', color: '#4d41b1', type: 'programming', ext: ['f', 'f90', 'f95', 'for'] },
  { name: 'Assembly', color: '#6E4C13', type: 'programming', ext: ['asm', 's'] },
  { name: 'Verilog', color: '#b2b7f8', type: 'programming', ext: ['v', 'vh'] },
  { name: 'VHDL', color: '#adb2cb', type: 'programming', ext: ['vhd', 'vhdl'] },
  { name: 'Solidity', color: '#AA6746', type: 'programming', ext: ['sol'] },
  { name: 'Emacs Lisp', color: '#c065db', type: 'programming', ext: ['el'] },
  { name: 'Common Lisp', color: '#3fb68b', type: 'programming', ext: ['lisp', 'lsp'] },
  { name: 'Scheme', color: '#1e4aec', type: 'programming', ext: ['scm', 'ss'] },
  { name: 'Racket', color: '#3c5caa', type: 'programming', ext: ['rkt'] },
  { name: 'Prolog', color: '#74283c', type: 'programming', ext: ['pro'] },
  { name: 'Ada', color: '#02f88c', type: 'programming', ext: ['adb', 'ads'] },
  { name: 'Vim Script', color: '#199f4b', type: 'programming', ext: ['vim'], names: ['.vimrc', 'vimrc'] },
  { name: 'Shell', color: '#89e051', type: 'programming', ext: ['sh', 'bash', 'zsh', 'fish'] },
  { name: 'PowerShell', color: '#012456', type: 'programming', ext: ['ps1', 'psm1', 'psd1'] },
  { name: 'Batchfile', color: '#C1F12E', type: 'programming', ext: ['bat', 'cmd'] },
  { name: 'Awk', color: '#c30e9b', type: 'programming', ext: ['awk'] },
  { name: 'Makefile', color: '#427819', type: 'programming', ext: ['mk'], names: ['Makefile', 'GNUmakefile', 'makefile'] },
  { name: 'CMake', color: '#DA3434', type: 'programming', ext: ['cmake'], names: ['CMakeLists.txt'] },
  { name: 'Dockerfile', color: '#384d54', type: 'programming', ext: ['dockerfile'], names: ['Dockerfile'] },
  { name: 'Nix', color: '#7e7eff', type: 'programming', ext: ['nix'] },
  { name: 'HCL', color: '#844FBA', type: 'programming', ext: ['tf', 'tfvars', 'hcl'] },
  { name: 'SQL', color: '#e38c00', type: 'programming', ext: ['sql'] },
  { name: 'GraphQL', color: '#e10098', type: 'programming', ext: ['graphql', 'gql'] },
  { name: 'Jupyter Notebook', color: '#DA5B0B', type: 'programming', ext: ['ipynb'] },
  { name: 'TeX', color: '#3D6117', type: 'programming', ext: ['tex', 'sty', 'cls'] },
  { name: 'HTML', color: '#e34c26', type: 'markup', ext: ['html', 'htm', 'xhtml'] },
  { name: 'CSS', color: '#563d7c', type: 'markup', ext: ['css'] },
  { name: 'SCSS', color: '#c6538c', type: 'markup', ext: ['scss'] },
  { name: 'Sass', color: '#a53b70', type: 'markup', ext: ['sass'] },
  { name: 'Less', color: '#1d365d', type: 'markup', ext: ['less'] },
  { name: 'Vue', color: '#41b883', type: 'markup', ext: ['vue'] },
  { name: 'Svelte', color: '#ff3e00', type: 'markup', ext: ['svelte'] },
  { name: 'Astro', color: '#ff5a03', type: 'markup', ext: ['astro'] },
  { name: 'Handlebars', color: '#f7931e', type: 'markup', ext: ['hbs', 'handlebars'] },
  { name: 'Pug', color: '#a86454', type: 'markup', ext: ['pug', 'jade'] },
  { name: 'Haml', color: '#ece2a9', type: 'markup', ext: ['haml'] },
  { name: 'Twig', color: '#c1d026', type: 'markup', ext: ['twig'] },
  { name: 'Blade', color: '#f7523f', type: 'markup', ext: ['blade'] },
  { name: 'EJS', color: '#a91e50', type: 'markup', ext: ['ejs'] },
  { name: 'Liquid', color: '#67b8de', type: 'markup', ext: ['liquid'] },
  { name: 'Svg', color: '#ff9900', type: 'data', ext: ['svg'] },
  { name: 'JSON', color: '#292929', type: 'data', ext: ['json', 'jsonc'] },
  { name: 'YAML', color: '#cb171e', type: 'data', ext: ['yml', 'yaml'] },
  { name: 'TOML', color: '#9c4221', type: 'data', ext: ['toml'] },
  { name: 'XML', color: '#0060ac', type: 'data', ext: ['xml', 'xsd', 'xsl'] },
  { name: 'CSV', color: '#237346', type: 'data', ext: ['csv', 'tsv'] },
  { name: 'INI', color: '#d1dbe0', type: 'data', ext: ['ini', 'cfg'] },
  { name: 'Markdown', color: '#083fa1', type: 'prose', ext: ['md', 'markdown'] },
  { name: 'reStructuredText', color: '#141414', type: 'prose', ext: ['rst'] },
  { name: 'Text', color: '#8f8f8f', type: 'prose', ext: ['txt'] },
];

const BY_EXT = new Map<string, LanguageDef>();
const BY_NAME = new Map<string, LanguageDef>();
for (const lang of LANGUAGES) {
  for (const e of lang.ext ?? []) BY_EXT.set(e, lang);
  for (const n of lang.names ?? []) BY_NAME.set(n, lang);
}

/**
 * Paths whose contents someone else wrote, or a tool generated. Linguist has
 * a hundred or so of these rules; this is the handful that covers what a
 * repository in a vault is actually likely to contain, and being a subset it
 * errs towards counting something it should have skipped rather than the
 * reverse.
 */
const VENDORED = /(^|\/)(node_modules|bower_components|vendor|third_party|thirdparty|Godeps|\.yarn|dist|build|out|target|__pycache__|\.venv|venv)\//;
const GENERATED = /(\.min\.(js|css)|\.map|-lock\.json|\.lock|\.pb\.go|_pb2\.py)$/;

/** One language's share of a ref, as the bar and the list beside it show it. */
export interface LanguageStat {
  name: string;
  color: string;
  bytes: number;
  /** Percentage of the counted bytes, 0-100. */
  share: number;
}

/**
 * Everything smaller than this disappears into "Other", so that a repository
 * with one stray file of forty languages still gets a legible bar.
 */
const MIN_SHARE = 0.5;
const OTHER_COLOR = '#8f8f8f';

/**
 * A tree wider than this is not measured. The parse is cheap, but a bar built
 * from a million files is neither more informative than one built from twenty
 * thousand nor worth the memory, and the root page has to stay quick.
 */
const MAX_FILES = 20000;

function classify(filePath: string): LanguageDef | null {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const byName = BY_NAME.get(name);
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  // A leading dot is the start of a dotfile's name, not an extension.
  if (dot <= 0) return null;
  return BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/**
 * The language breakdown of a ref, biggest share first, or an empty list when
 * nothing at the ref is countable (an empty repository, a tree of documents,
 * or one wider than MAX_FILES).
 *
 * Sizes come from `git ls-tree -l`, which is the size of the blob as stored:
 * for a file kept in LFS that is the size of its pointer, so an LFS-heavy
 * repository reports the language of its pointers' neighbours. Symlinks and
 * submodule gitlinks are not files here and are skipped.
 */
export async function languageBreakdown(dir: string, ref: string): Promise<LanguageStat[]> {
  let out: string;
  try {
    out = (await execGit(dir, ['ls-tree', '-r', '-l', '-z', ref])).toString('utf8');
  } catch {
    return [];
  }
  const bytes = new Map<string, { def: LanguageDef; total: number }>();
  let files = 0;
  for (const item of out.split('\0')) {
    if (!item) continue;
    if (++files > MAX_FILES) return [];
    // <mode> <type> <sha> <size>\t<path>, as listTree() parses it.
    const m = item.match(/^(\S+) (\S+) (\S+) +(\S+)\t([\s\S]*)$/);
    if (!m) continue;
    const [, mode, type, , sizeText, filePath] = m;
    if (type !== 'blob' || mode === '120000') continue;
    const size = parseInt(sizeText, 10);
    if (!Number.isFinite(size) || size === 0) continue;
    if (VENDORED.test(filePath) || GENERATED.test(filePath)) continue;
    const def = classify(filePath);
    if (!def || (def.type !== 'programming' && def.type !== 'markup')) continue;
    const entry = bytes.get(def.name);
    if (entry) entry.total += size;
    else bytes.set(def.name, { def, total: size });
  }
  const total = [...bytes.values()].reduce((sum, e) => sum + e.total, 0);
  if (total === 0) return [];
  const all = [...bytes.values()]
    .map((e) => ({ name: e.def.name, color: e.def.color, bytes: e.total, share: (e.total / total) * 100 }))
    .sort((a, b) => b.bytes - a.bytes);
  const kept = all.filter((l) => l.share >= MIN_SHARE);
  const rest = all.filter((l) => l.share < MIN_SHARE);
  if (rest.length > 0) {
    kept.push({
      name: 'Other',
      color: OTHER_COLOR,
      bytes: rest.reduce((sum, l) => sum + l.bytes, 0),
      share: rest.reduce((sum, l) => sum + l.share, 0),
    });
  }
  return kept;
}
