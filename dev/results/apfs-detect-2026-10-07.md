# APFS detection by name, not by statfs number (2026-10-07)

Branch `operator/31dbc0`, from main @ e74113f.

## What failed

CI run 37714505956 (tag electron-v0.28.1), `test` job, runner image macos-14-arm64 20260831.0302.1, macOS 14.8.9. Two tests in `electron/src/main/worktree.test.ts` failed:

- `createWorktree clones them as real directories, with symlinks inside kept as symlinks`: `cloned` was `[]`.
- `the gate names a non-APFS path`: `cloneBlockedReason(SANDBOX, SANDBOX)` returned `'the checkout is not on an APFS volume'` instead of `null`.

The runner log shows the gate refusing both directories:

    [worktree] /var/folders/s6/.../repo-gW5o1k-3b3880: cloned nothing in 7 ms; not cloned:
    electron/node_modules (the checkout is not on an APFS volume); node_modules (the checkout is not on an APFS volume)

The electron-v0.28.0 run (37534538150) passed the same test job on 2026-10-06 on the same image name. Only its `release` job failed.

## Cause

`cloneBlockedReason` compared `statfs(path).type` with a constant `APFS_FSTYPE = 26`, a value measured on the dev Mac. On macOS that number is `f_type`, the index XNU assigns when a file system registers. It is not a fixed constant across machines. On the runner the temp directory reported a number other than 26, so the gate treated an APFS volume as non-APFS.

This was also a product bug. On any Mac where APFS registers with a different number, `node_modules` was never cloned into new worktrees, and every lane got the "node_modules not cloned ... Run npm install" note.

I did not get the runner's actual number. The log only shows that it was not 26.

## Change

`electron/src/main/worktree.ts`:

- Removed `APFS_FSTYPE` and the `statfs` import.
- `parseMountTable(out)` parses macOS `mount` lines (`<device> on <mount point> (<type>, <options>)`) into `{ mountPoint, type, local }`. The device is matched up to the first ` on ` and the mount point up to the last ` (`, so mount points with spaces or ` on ` in them parse correctly.
- `localMounts()` runs `/sbin/mount` (5 s timeout) and keeps only mounts with the `local` option. Network and autofs mount points are never stat'ed, so the lookup cannot block on a server.
- `volumeType(path, mounts?)` returns the type name of the local mount whose mount point has the same device number as `path`, or `null`. Matching by device handles firmlinks (`/Users/...` is on the volume mounted at `/System/Volumes/Data`). Device numbers are compared as bigints because devfs's is near 2^64 and loses precision as a JS number.
- `cloneBlockedReason` reads the mount table once and requires both `src` and `destParent` to be `'apfs'`. The non-APFS refusal text is unchanged, and so is the same-device check after it.

Cost: 4 to 7 ms per gate call on this Mac (three calls measured), one `mount` subprocess each. The gate runs once per `node_modules` directory.

Not done: the alternatives of probing with clonefile and falling back on ENOTSUP/EXDEV. `cp -c` silently falls back to a full copy, so it can't be used as a probe. Node's `COPYFILE_FICLONE_FORCE` returned ENOSYS on macOS when this code was written (comment in `worktree.ts`). I did not re-test it, because the name check is enough.

## Tests

`electron/src/main/worktree.test.ts`, in `node_modules cloned into a new worktree`:

- Kept `the gate names a non-APFS path` (`/dev` is refused, the temp directory passes). It no longer depends on any number.
- New: `volumeType` returns `'apfs'` for the temp directory and `'devfs'` for `/dev` (darwin only).
- New: `parseMountTable` against lines copied from this Mac's `mount` (home path renamed), plus one constructed line with spaces and ` on ` in the mount point. Covers the autofs line (not local) and the CoreDevice devicefs line, whose device field contains spaces and a URL.
- New: a path on no listed mount gets `null`.

## Results

    $ npm run typecheck        # electron/
    > tsc -p tsconfig.json --noEmit && tsc -p tsconfig.renderer.json --noEmit
    (no errors)

    $ npx vitest run src/main/worktree.test.ts
     Test Files  1 passed (1)
          Tests  73 passed (73)

    $ npm test                 # electron/, full suite
     Test Files  50 passed (50)
          Tests  891 passed (891)

These runs are all on this Mac, where APFS is 26, so the old code passed here too. The fix is confirmed on the runner only when CI runs this branch (or main after the merge). If the runner's temp directory is APFS, as the image's macOS 14 Data volume should be, both failing tests pass there.
