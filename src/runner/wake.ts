import * as crypto from 'crypto';
import * as http from 'http';

// The listener a runner that stops when idle needs in front of it.
//
// A runner talks to the vault only outbound, which is what lets one sit behind
// NAT with nothing open. That same property means a runner which has exited
// cannot be reached at all, so a runner meant to stop when idle has to be
// startable by something: on Fly, a request to the app starts the machine that
// serves it, and the request itself is of no interest beyond having arrived.
//
// So this answers, and does nothing else. It carries no job, no configuration,
// and no reply worth reading; what matters is the platform in front of it
// noticing that a request came in. The shared secret is here because starting
// a machine costs its owner money, and an endpoint that anyone could poke
// would be a way to spend it.

export interface WakeListener {
  readonly port: number;
  close(): Promise<void>;
}

function secretOk(presented: string | undefined, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length is not a secret worth padding for, and comparing buffers of
  // different lengths throws.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Listen for wake requests on `port`, calling `onWake` for each authorized one.
 *
 * Resolves once the socket is listening, so that a caller can report the port
 * it actually got, and rejects if the port cannot be bound: a runner whose
 * wake endpoint is not up is one nothing can start again, which is worth
 * failing on rather than discovering later as a run that never began.
 */
export function startWakeListener(opts: {
  port: number;
  host?: string;
  secret: string;
  onWake: () => void;
}): Promise<WakeListener> {
  const server = http.createServer((req, res) => {
    if (!secretOk(req.headers['x-feorge-wake'] as string | undefined, opts.secret)) {
      res.writeHead(401).end();
      return;
    }
    opts.onWake();
    res.writeHead(204).end();
  });
  // A wake request carries nothing, so a client that opens a connection and
  // says nothing is either a mistake or a nuisance; either way it should not
  // hold a socket open.
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : opts.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
