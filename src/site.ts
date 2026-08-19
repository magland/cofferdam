import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { containedIn } from './ops';
import { findRepo, siteDir } from './scan';
import { send404, wildcard } from './web';

// Serving a repository's static site. This is the only place in cofferdam where
// bytes supplied by someone other than the server are returned as HTML, so it
// is also the only place that needs to think about what that HTML is allowed to
// do. Raw blob views and LFS downloads are sandboxed where they are served
// (src/browse.ts, src/lfs.ts); site files were not, and a document served from
// the forge's own origin can read the visitor's session, scrape the CSRF token
// out of any page that session can fetch, and act as them. Anyone who can write
// <repo>.site held that capability, which is every user with push scope on the
// repository and every workflow that publishes it.
//
// Two answers, and the mode says which is in force. 'sandbox' is the default and
// works anywhere: the document is placed in an opaque origin, so it has no
// access to cookies and cannot make a credentialed request. 'host' is for a site
// served from its own hostname, where the browser's own origin separation is
// doing the work and sandboxing would only take capability away from the site
// for nothing.

export type SiteMode = 'sandbox' | 'host';

/**
 * The headers a site response carries. Set immediately before the body is sent,
 * on every path that sends one, the site's own 404.html included: a response
 * that escapes this is a response running with the forge's authority.
 */
export function setSiteHeaders(res: Response, mode: SiteMode): void {
  // nosniff in both modes. A file whose declared type is wrong is not licence
  // to guess something more dangerous.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (mode === 'host') return;
  // Deliberately without allow-same-origin, which is what puts the document in
  // an opaque origin: no cookie jar, no document.cookie, no localStorage or
  // IndexedDB, no service worker registration, and every request it makes to
  // the vault is cross-origin and credential-less. Script still runs, so the
  // feature survives.
  res.setHeader(
    'Content-Security-Policy',
    'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'
  );
  // Load-bearing, not redundant. A page in an opaque origin cannot fetch its
  // own sibling files without it, which breaks any single-page app, wasm
  // loader, or data-driven site. Those fetches still carry no credentials, so
  // nothing is returned to an attacker. Site responses only: never on a forge
  // page and never on an API route.
  res.setHeader('Access-Control-Allow-Origin', '*');
}

/**
 * Serve one path out of a repository's site directory.
 *
 * The site-relative path depends on the mode, because the two surfaces disagree
 * about where the site starts: under /:collection/:repo/site/ it is the
 * wildcard, and on a site's own hostname the repository is the origin root, so
 * it is the whole of req.path.
 */
export function serveSite(
  root: string,
  collection: string,
  repo: string,
  req: Request,
  res: Response,
  mode: SiteMode
): void {
  const found = findRepo(root, collection, repo);
  if (!found) {
    send404(res, `Repository ${collection}/${repo} not found`);
    return;
  }
  const dir = siteDir(root, found.collection, found.name);
  if (!dir) {
    send404(
      res,
      `No site for ${found.collection}/${found.name}. Create a ${found.name}.site directory next to the repository, with an index.html at its root.`
    );
    return;
  }
  // The real path of the site directory, which every path we serve has to
  // sit under. It is resolved once here so that a vault reached through a
  // symlinked root still compares equal.
  let dirReal: string;
  try {
    dirReal = fs.realpathSync(dir);
  } catch {
    send404(res);
    return;
  }
  const relative = mode === 'host' ? req.path : wildcard(req);
  const segs = relative.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..' || s.includes('\0'))) {
    send404(res);
    return;
  }
  // Site content is written by whatever published it, which may be a
  // workflow unpacking a tar, so it can contain symlinks. Refusing `..`
  // segments stops a traversal spelled in the URL but not a link on disk
  // pointing at /etc/passwd, at the vault's own files, or into another
  // repository's site, which has a different owner. Every path we are
  // about to read is therefore resolved and required to land strictly
  // under dirReal; containedIn refuses the directory itself as well as
  // anything outside it, so only files below the site root are servable.
  //
  // Resolving and then opening is two syscalls, so a link swapped in
  // between them would still be followed. Closing that window means
  // holding an open handle and checking what we hold, which is more
  // machinery than this is worth; the interesting case is content that
  // was already on disk when the request arrived.
  const statInside = (p: string): fs.Stats | null => {
    if (!containedIn(dirReal, p)) return null;
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  };
  const requested = path.join(dir, ...segs);
  // The site root is the directory itself, which statInside refuses; it is
  // still a directory request, and resolves to the index.html below it.
  const isDir = segs.length === 0 || statInside(requested)?.isDirectory() === true;
  let target = requested;
  if (isDir) {
    if (!req.path.endsWith('/')) {
      res.redirect(`${req.path}/`);
      return;
    }
    target = path.join(requested, 'index.html');
  }
  // A refused path answers exactly as a missing one does, so a prober
  // learns nothing about what is really there from the difference.
  const stat = statInside(target);
  if (!stat || !stat.isFile()) {
    const notFound = path.join(dir, '404.html');
    const notFoundStat = statInside(notFound);
    if (notFoundStat && notFoundStat.isFile()) {
      setSiteHeaders(res, mode);
      res.status(404).sendFile(notFound);
    } else {
      send404(res, 'Page not found in this site');
    }
    return;
  }
  setSiteHeaders(res, mode);
  res.sendFile(target);
}
