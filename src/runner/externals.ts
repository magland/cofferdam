import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execInContainer } from './docker';

// JavaScript actions need a node interpreter inside the job's container.
// GitHub's runner ships its own and mounts it in, which is why an image
// without node still runs `actions/checkout`. We do the same, but only when
// we have to: if the image already has a new enough node, that one is used,
// and nothing is downloaded. Images built for CI almost always do.
//
// The downloaded builds are the official linux-x64/arm64 ones, which are
// linked against glibc. An Alpine or other musl image therefore cannot use
// them, and gets a clear message rather than a confusing loader error.

export class ExternalsError extends Error {}

// Pinned so a job's behavior does not change under it when upstream releases.
const NODE_VERSIONS: Record<number, string> = {
  16: '16.20.2',
  20: '20.19.5',
  24: '24.10.0',
};

export const EXTERNALS_MOUNT = '/cofferdam/externals';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new ExternalsError((stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

export function defaultExternalsDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'cofferdam', 'externals');
}

function nodeArch(): string {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

export class Externals {
  private containerNode: string | null | undefined;

  constructor(private dir: string = defaultExternalsDir()) {}

  // The node binary to run an action with, as a path inside the container.
  async nodeFor(
    containerId: string,
    major: number,
    onLine: (line: string) => void
  ): Promise<string> {
    const inImage = await this.imageNode(containerId);
    // Action bundles are transpiled to a conservative target, so any node at
    // or above the version the action asks for runs them. Rejecting an image
    // whose node is merely newer would mean downloading for no reason.
    if (inImage !== null && inImage.major >= major) return inImage.path;
    return this.provision(containerId, major, onLine);
  }

  private async imageNode(containerId: string): Promise<{ path: string; major: number } | null> {
    if (this.containerNode === undefined) {
      let out = '';
      const handle = execInContainer(
        containerId,
        ['sh', '-c', 'command -v node >/dev/null 2>&1 && node --version || true'],
        (line) => {
          out += line;
        }
      );
      await handle.done;
      const m = out.match(/v(\d+)\./);
      this.containerNode = m ? m[1] : null;
    }
    if (this.containerNode === null) return null;
    return { path: 'node', major: parseInt(this.containerNode, 10) };
  }

  private async provision(containerId: string, major: number, onLine: (line: string) => void): Promise<string> {
    const version = NODE_VERSIONS[major] ?? NODE_VERSIONS[20];
    const arch = nodeArch();
    const name = `node-v${version}-linux-${arch}`;
    const target = path.join(this.dir, name);
    const bin = path.join(target, 'bin', 'node');
    if (!fs.existsSync(bin)) {
      onLine(`Providing node ${version} for JavaScript actions (the image has none)`);
      await this.download(version, name, target);
    }
    const containerPath = `${EXTERNALS_MOUNT}/${name}/bin/node`;
    // Fail here, with an explanation, rather than letting the first action
    // die with "no such file or directory" from a dynamic loader.
    let ok = false;
    const check = execInContainer(
      containerId,
      ['sh', '-c', `"${containerPath}" --version >/dev/null 2>&1 && echo yes || true`],
      (line) => {
        if (line.includes('yes')) ok = true;
      }
    );
    await check.done;
    if (!ok) {
      throw new ExternalsError(
        `the image cannot run the provided node binary, which is a glibc build. ` +
          `Use an image that includes node (most CI images do), or one based on glibc rather than musl.`
      );
    }
    return containerPath;
  }

  private async download(version: string, name: string, target: string): Promise<void> {
    const url = `https://nodejs.org/dist/v${version}/${name}.tar.gz`;
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (e) {
      throw new ExternalsError(`could not download node ${version}: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) throw new ExternalsError(`could not download node ${version}: ${url} answered ${res.status}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.tmp-${process.pid}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    const tarball = path.join(tmp, 'node.tar.gz');
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    const extracted = path.join(tmp, 'out');
    fs.mkdirSync(extracted);
    await run('tar', ['-xzf', tarball, '-C', extracted, '--strip-components=1']);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(extracted, target);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  hostDir(): string {
    return this.dir;
  }
}
