# Git LFS

Large files kept outside the repository, in a bucket or inside the vault.

A vault keeps every byte ever committed, since repositories are stored as bare git repositories on a filesystem. That is fine for source code and expensive for large binary files, which grow the vault without bound and cannot be pruned without rewriting history. [Git LFS](https://git-lfs.github.com/) replaces those files in the repository with small pointer files and keeps the actual bytes elsewhere, so the repository stays small and the large objects live in inexpensive object storage. The trade-off is latency: fetching an LFS object is a separate HTTP request rather than bytes already present in a packfile the client just downloaded.

Nothing needs to be enabled. The server implements the LFS Batch API on every repository, and clients find it without configuration:

```bash
git lfs track '*.nwb'
git add .gitattributes data/session.nwb
git commit -m "Add a recording"
git push
```

Downloading is anonymous, so `git clone` followed by `git lfs pull` on a public repository needs no credentials; uploading requires push scope over the repository, the same token and the same scope as `git push`. There is no separate LFS permission and no per-repository setting to turn on.

Push-to-create still works for a repository that tracks files with LFS. git fetches the remote's refs before it runs the pre-push hook that uploads the objects, and it is that first request which creates the repository here, so the objects arrive at a repository that already exists.

Objects are stored either in an S3-compatible bucket or inside the vault, chosen from the environment at startup. With no bucket variables set, the **local** backend stores objects in a sibling directory next to the repository, following the same convention as sites:

```
<vault>/collections/alice/repos/
  webapp.git/     (the repository, holding pointer files)
  webapp.lfs/     (its LFS objects, sharded by object id)
```

This keeps `npm run dev` and the smoke test working with no credentials and is a reasonable choice for a laptop vault, but it stores the large objects on the same disk the feature exists to protect. For a deployment with a small volume, point it at a bucket instead. The server then returns presigned URLs and the client transfers bytes directly to and from the bucket, so large-file content never passes through the cofferdam process.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COFFERDAM_LFS_BUCKET` or `BUCKET_NAME` | unset | Bucket name |
| `COFFERDAM_LFS_ENDPOINT` or `AWS_ENDPOINT_URL_S3` | unset | S3 endpoint base URL |
| `AWS_ACCESS_KEY_ID` | unset | Access key |
| `AWS_SECRET_ACCESS_KEY` | unset | Secret key |
| `AWS_REGION` | `auto` | Credential-scope region; `auto` is correct for R2 and Tigris |
| `COFFERDAM_LFS_PREFIX` | unset | Optional key prefix, so LFS can share a bucket with other data |
| `COFFERDAM_LFS_MAX_SIZE` | `5000000000` | Largest object accepted, in bytes |
| `COFFERDAM_LFS_ADDRESSING` | `path` | `path` or `vhost`; path style is required by R2 |
| `COFFERDAM_LFS` | unset | Set to `off` to force the local backend even with bucket variables present |

Credentials are read from the environment only and are never written into `config.json` or `vault.json`: the vault is the backup unit and stays portable between deployments with different buckets. Setting some but not all of the four bucket variables is a startup error that names what is missing, rather than a silent fall back to storing large objects on the volume. The server logs which backend is active on each start.

Objects are sharded the same way in both backends, by object id: a bucket key is `<collection>/<repo>.lfs/<oid[0:2]>/<oid[2:4]>/<oid>`, and on the volume the same shards sit under the repository, in `<vault>/collections/<collection>/repos/<repo>.lfs/`. Moving a vault between the two is `rclone copy` and nothing else. Bucket keys kept their shape when the vault's layout changed, since a bucket is not the vault's directory and rewriting every key would mean moving objects nobody asked to move.

### Storage providers

All three use the same code path.

- **Cloudflare R2** (recommended). Endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`, path-style addressing. Storage is $0.015/GB-month with no egress fees, and the free tier covers 10 GB, 1 million Class A operations, and 10 million Class B operations per month. The absence of egress fees is the reason to prefer it over the alternatives: an LFS object is downloaded far more often than it is uploaded, and it is the one part of a vault's traffic the daily egress cap does not count (see [Outgoing bytes](deploying.md#outgoing-bytes)), so a provider that charges for transfer is a bill with nothing bounding it. Use Standard storage rather than Infrequent Access: IA saves a third on storage but doubles operation costs, adds $0.01/GB retrieval, imposes a 30-day minimum storage duration, and is excluded from the free tier, which suits objects people occasionally clone poorly.
- **Tigris** (convenient on Fly). `fly storage create` provisions a bucket and injects `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` as Fly secrets, so there is nothing further to configure, which is why `cofferdam deploy fly --lfs-bucket` uses it. Convenience is its whole advantage; consult its pricing page for what transfer costs, and prefer R2 if that matters to you. Pointing a deployed vault at R2 later is four `fly secrets set` values and a restart, plus `rclone copy` to move the objects already there.
- **Amazon S3.** Set `AWS_REGION` to the bucket's real region, and `COFFERDAM_LFS_ADDRESSING=vhost` if path-style addressing is unavailable for the bucket.

Bucket CORS needs no configuration. The git-lfs client is not a browser, and the download link on a file's page is a top-level navigation, so neither path is subject to CORS.

### In the web interface

A file stored with LFS shows a download card giving its true size and object id, rather than the pointer text; the download link redirects to the object in storage. `?plain=1` shows the pointer source, as GitHub does. Editing such a file in the browser is refused, since committing ordinary text over a pointer would silently corrupt the repository's LFS state; deleting it is still allowed, as it is a legitimate git operation. Deleting a repository removes its stored objects along with it.

### Limitations

- **Existing large files are unaffected.** LFS prevents future growth; it does not shrink a repository retroactively. Files already committed as ordinary blobs stay in the packfiles, and moving them requires `git lfs migrate import` on a client, which rewrites history and changes every downstream commit id.
- **Directory listings show pointer sizes.** Tree listings take their sizes from `git ls-tree -l`, which reports the pointer's size of roughly 130 bytes rather than the real file size. The file's own page shows the true size.
- **Commit diffs show pointer diffs**, which is git's own behavior without the LFS diff driver configured.
- **Orphaned objects leak.** Objects whose commits never arrived, or which became unreachable through a force push or a branch deletion, stay in storage. Collecting them properly means enumerating every pointer blob reachable from every ref across all history; a `cofferdam lfs gc` is left for later.
- **Object size is capped** by `COFFERDAM_LFS_MAX_SIZE`, because the `basic` transfer adapter uploads with a single PUT. Note what the cap is worth in each backend. Locally it is enforced on the bytes as they arrive. Against a bucket it can only be enforced on the size the client declares in the batch request, since the upload goes straight to the bucket: someone with push access who declares a small size and then sends a large body will succeed, and the bytes become orphans that `verify` reports but nothing removes. Treat it as a guard against honest mistakes rather than a quota, and use bucket-side limits or billing alerts if you need a real one.
- **File locking is not implemented.** The `/locks` endpoints return 404, which git-lfs reads as locking being unsupported.
