# Backups

The database holds Meta long-lived access tokens, months of `StyleExample` rows (the learned voice) and `PostInsight` history. None of it is reconstructible. Until this system ran, all of it lived on one Supabase instance with no dump anywhere.

**Status: code complete, not yet verified against real R2.** See [Turning it on](#turning-it-on). Until the corruption drill passes, treat this as untested code, not as a backup.

## How it works

```
pg_dump --format=plain | gzip | gpg --symmetric  →  temp file  →  R2 (single PUT)
```

- **[db-backup.ts](../apps/api/src/services/db-backup.ts)** — pipeline, retention, scheduling predicate, restore drill
- **[r2.ts](../apps/api/src/services/r2.ts)** — minimal SigV4 S3 client (put / list / get / delete)
- **[admin.ts](../apps/api/src/routes/admin.ts)** — status, manual run, restore drill

Objects land at `smm/db/smm-<ISO compact>.sql.gz.gpg`, which sorts lexicographically in chronological order.

### Scheduling

Checked on the **engagement-worker tick**, not on a `setInterval`. A timer resets on every deploy or host restart, so a daily job silently skips days on a box that restarts often. The tick asks "is the newest object in R2 older than 23 hours?" and acts on the answer.

R2 itself is the source of truth for "when did the last backup succeed" — no local state, no extra column, nothing to drift.

The check is throttled to once per 30 minutes in memory (the tick runs every 90s), but **always runs on the first tick after boot**. That is what makes a restart pick up a missed day immediately rather than up to 30 minutes later.

23 hours rather than 24 is deliberate: a strict 24h threshold plus tick jitter drifts forward a little each day until it eventually skips a calendar day.

### Retention

Grandfather-father-son: the newest backup of each of the 7 most recent days present, plus the newest of each of the 4 most recent weeks present. Weeks run Monday–Sunday.

It counts buckets **present in the bucket listing**, not calendar days ending now. With a sparse history that keeps an old backup rather than deleting it — the right way to err, since deleting the only historical copy to satisfy a calendar rule is worse than holding one extra object. Once enough newer weeks accumulate, the old one ages out normally.

Pruning happens **only after a successful upload**, so a failed run never deletes the backups it was going to replace.

## Restoring

The whole point of gpg over encrypting in Node: a disaster-recovery artifact must not depend on the application that died. Any machine with `gpg` and `psql` can restore, with no SMM code involved.

```bash
# 1. Download the object from the R2 dashboard (or any S3 client).
# 2. Decrypt, decompress, restore:
gpg -d smm-20260909T120000Z.sql.gz.gpg | gunzip | psql "$DIRECT_URL"
```

You will be prompted for `BACKUP_PASSPHRASE`.

To inspect without restoring:

```bash
gpg -d smm-20260909T120000Z.sql.gz.gpg | gunzip | head -100
```

### The automated drill

`POST /admin/backup/restore-test` pulls the newest backup, creates a scratch database, restores into it, counts rows in `Account` / `Post` / `StyleExample` / `PostInsight`, then drops the scratch database. It is slow (minutes on a real dump) and deliberately manual.

An untested backup is not a backup. This is what turns "the upload returned 200" into evidence.

## Turning it on

1. Create an R2 bucket and an API token with object read/write on it.
2. Fill in `.env` (placeholders are already there):

   | Variable | Notes |
   |---|---|
   | `BACKUP_ENABLED` | `true` only once all five below are set |
   | `BACKUP_R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `BACKUP_R2_BUCKET` | |
   | `BACKUP_R2_ACCESS_KEY_ID` | |
   | `BACKUP_R2_SECRET_ACCESS_KEY` | |
   | `BACKUP_PASSPHRASE` | **Losing this loses every backup.** Store it somewhere that is not this database. |

3. `GET /admin/backup/status` — confirm `configured: true`.
4. `POST /admin/backup/run` — confirm an object appears in the bucket.
5. `POST /admin/backup/restore-test` — confirm `ok: true`.
6. **The verification that actually matters:** corrupt a byte in the uploaded object, re-run the drill, and confirm it *fails*. A drill that cannot fail proves nothing.

Only after step 6 is this a backup.

## Design notes

Three deviations from the original plan sketch, each deliberate:

**Spool to a temp file, not a streamed multipart PUT.** The pipeline never buffers in *memory*, which is the constraint that matters on a 1 GB box. Disk is the cheap resource (~100 GB usable after boot volumes); a spooled file lets the upload send a known `Content-Length` instead of hand-rolling multipart signing.

**No `@aws-sdk/client-s3`.** SigV4 path-style signing is ~60 lines of `node:crypto`. Pulling a large dependency tree onto a small box to make four requests is not worth it, and it keeps the backup path free of third-party code entirely. Requests use `x-amz-content-sha256: UNSIGNED-PAYLOAD`, which is what lets a large dump stream out of a file handle without being hashed into memory first.

**`gpg` symmetric, not AES in Node.** See [Restoring](#restoring).

The passphrase is passed to gpg over **file descriptor 3, never argv** — an argv passphrase is visible in `ps` to anything else on the box.

## Gotchas

**`postgresql-client-17` comes from PGDG, not Debian.** Bookworm ships client 15, and `pg_dump` refuses to dump a server newer than itself. Against a PG 16/17 Supabase instance the Debian client fails with a version-mismatch error. The [Dockerfile](../Dockerfile) adds the PGDG apt repo for this reason. It only shows up in the deployed container, never locally.

**`pg_dump` must use `DIRECT_URL`, not `DATABASE_URL`.** Supabase's pooled (pgbouncer) endpoint does not support the session-level statements a dump issues and fails partway through with confusing errors.

**Backups are enabled per-process.** After the Phase 0.5 two-box split, decide deliberately which box runs them — running on both doubles the objects and the R2 traffic for no benefit.
