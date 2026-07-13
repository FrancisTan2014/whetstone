# Backup and restore

Whetstone keeps your learning history in a small set of durable data roots on your own machine:

- the **database** (`DATABASE_DIR`) — works, reading units, blocks, notes, Memory prompts/reviews,
  recitation plans/passages/reviews, diary entries, and every index over them;
- **source files** (`SOURCE_FILES_DIR`) — uploaded source files kept for provenance;
- **image resources** (`IMAGE_RESOURCES_DIR`) — images extracted from imported works.

`pnpm data:backup` captures all of them into **one verified archive**, and `pnpm data:restore`
loads that archive into a **fresh, empty** target. The archive is versioned and checksummed, so a
restore either reproduces your data exactly or fails loudly — there is no half-restored state.

This slice owns the **mechanism**. Scheduling and retention (how often, how many copies, where the
archives live) stay with you / the host; a host-scheduler example is at the end.

## Prerequisites

- A **persistent** database. Backup refuses an in-memory database: set `DATABASE_DIR` to your
  database directory before backing up. The `dev` script defaults it to a git-ignored `.data/db`.
- Run the commands from the repository root. Everything after `--` is passed to the tool.

Keep archives **out of git** and off shared/untrusted storage — they contain all your personal data.

## Back up

```bash
# macOS / Linux
DATABASE_DIR=./.data/db pnpm data:backup -- --output ./backups/whetstone-2026-07-12.zip
```

```powershell
# Windows (PowerShell)
$env:DATABASE_DIR = ".\.data\db"
pnpm data:backup -- --output .\backups\whetstone-2026-07-12.zip
```

The command dumps the database through PGlite's supported `dumpDataDir()` API (never a live
directory copy), collects every configured file root, writes the archive to a temporary
`<output>.partial` file, re-reads and verifies it end to end, then atomically renames it into place.
It **refuses to overwrite** an existing `--output` artifact, and a configured-but-unreadable root
fails with that root's exact path and remedy. On success it prints the archive size, the database
size, a per-root file/byte count, and `Backup verified.`

The archive's `manifest.json` records the format version, creation time, app and schema version, the
configured root inventory, and a byte count plus SHA-256 checksum for every payload.

## Restore

Restore always targets a **new, empty directory** — it never writes over a live data root.

```bash
# macOS / Linux
pnpm data:restore -- --input ./backups/whetstone-2026-07-12.zip --target ./restored
```

```powershell
# Windows (PowerShell)
pnpm data:restore -- --input .\backups\whetstone-2026-07-12.zip --target .\restored
```

Restore validates the archive's format version and every checksum **before** writing anything,
refuses a non-empty `--target`, then writes the file roots and loads the database through PGlite's
`loadDataDir` into the target. It runs the current migrations and finishes with an integrity probe
that opens the restored database, counts rows, and checks that representative uploaded-source files
exist on disk. A corrupt or truncated archive, a checksum mismatch, an incompatible format version, a
missing payload, or a non-empty target each fails loudly with what happened and the safe remedy — no
success-shaped fallback.

The restored data lands under the target as:

- `./restored/database` — the restored database directory;
- `./restored/sources` — restored source files;
- `./restored/images` — restored image resources.

To run the app against restored data, point the settings at those subdirectories:

```bash
DATABASE_DIR=./restored/database \
SOURCE_FILES_DIR=./restored/sources \
IMAGE_RESOURCES_DIR=./restored/images \
pnpm --filter @whetstone/server dev
```

## Restore drill (practice before you rely on it)

A backup you have never restored is a guess. Rehearse the full round-trip on a throwaway target:

1. Take a backup: `pnpm data:backup -- --output ./backups/drill.zip`.
2. Restore into a scratch directory: `pnpm data:restore -- --input ./backups/drill.zip --target ./restore-drill`.
   Confirm it prints `Integrity probe passed` and a plausible entry/file count.
3. Start the server against the restored roots (the command above, pointed at `./restore-drill/*`)
   and spot-check that your works, notes, and Memory queue are present.
4. Delete `./restore-drill` when done. Repeat after any major upgrade so a real recovery is routine,
   not a first attempt under pressure.

## Scheduling on the host (example)

Scheduling and retention are the host's job. Point your scheduler at the same `pnpm data:backup`
command with a timestamped `--output`, and prune old archives however you prefer.

### Windows — Task Scheduler

```powershell
# Daily at 02:00; writes a dated archive next to your data.
$action = New-ScheduledTaskAction -Execute "pnpm" `
  -Argument "data:backup -- --output C:\whetstone-backups\whetstone-$(Get-Date -Format yyyyMMdd).zip" `
  -WorkingDirectory "C:\src\whetstone"
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00AM
Register-ScheduledTask -TaskName "Whetstone backup" -Action $action -Trigger $trigger
```

Set `DATABASE_DIR` (and any non-default file-root paths) in the task's environment so the command
sees your persistent database.

### macOS / Linux — cron

```cron
# Daily at 02:00; run from the repo so pnpm resolves, and export the data roots.
0 2 * * * cd /path/to/whetstone && DATABASE_DIR=./.data/db pnpm data:backup -- --output "$HOME/whetstone-backups/whetstone-$(date +\%Y\%m\%d).zip"
```

Rotating or copying archives off-machine, and how many to keep, remain your policy — this tool only
produces and verifies each archive.
