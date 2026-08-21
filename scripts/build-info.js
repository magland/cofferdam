// Stamps the build. Run by `npm run build`, after tsc, and writes
// dist/build-info.json for src/version.ts to read back at runtime.
//
// The stamp exists because package.json cannot say which build a vault is
// running: main carries the last release's version until the next bump, so
// "0.3.0" names a range of commits rather than one. The commit here narrows it
// to exactly one, and the date says when that commit was compiled, which is
// what an operator comparing a deployed vault against a fix actually wants.
//
// Both fields can be supplied through the environment, because the place that
// most needs them is the one place git is absent: an image build gets only
// src/ and package.json, so .github/workflows/image.yml passes the commit it
// checked out as a build argument. A build with neither git nor those
// variables writes nulls, and the UI says the build is unknown rather than
// showing something invented.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

function fromGit(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function commit() {
  const given = (process.env.MOCHI_BUILD_COMMIT || '').trim();
  if (given) return given.slice(0, 12);
  const head = fromGit(['rev-parse', '--short=7', 'HEAD']);
  if (!head) return null;
  // A build made from an edited tree is not the commit it names, and saying so
  // is the difference between a stamp that can be trusted and one that cannot.
  return fromGit(['status', '--porcelain', '--untracked-files=no']) ? `${head}-dirty` : head;
}

function builtAt() {
  const given = (process.env.MOCHI_BUILD_DATE || '').trim();
  if (given && !isNaN(new Date(given).getTime())) return new Date(given).toISOString();
  return new Date().toISOString();
}

const stamp = { commit: commit(), builtAt: builtAt() };
const out = path.join(root, 'dist', 'build-info.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`build ${stamp.commit ?? 'unknown'} at ${stamp.builtAt}`);
