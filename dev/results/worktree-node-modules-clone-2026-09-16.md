# node_modules cloned into new worktrees (2026-09-16)

Commit `01114ff` on `operator/worktree-node-modules-clone`, branched from
`operator/lane-worktree-setting` (`383921f`). Merge order: stage 1, then the lane setting, then
this.

Not GUI-verified. Nothing was created or removed in `~/.operator/worktrees`: tests used temp
`OPERATOR_DIR` sandboxes, and the measurement used a throwaway repo and `OPERATOR_DIR` in the
session scratchpad, deleted afterwards.

## What changed

`createWorktree` (`electron/src/main/worktree.ts`) now clones dependencies after
`git worktree add`, for fresh worktrees and for reattached ones (`withDependencies`).

1. **Finding them:** `ignoredNodeModules(root)` runs
   `git ls-files --others --ignored --exclude-standard --directory -z` in the source checkout and
   keeps entries ending in `node_modules/`.
   - I used git instead of a hand-written walk. It is the bounded walk the task describes: git
     never descends into an ignored directory, so it never enters `node_modules` or `.git`. It also
     answers "is it ignored" and stops at ignored build output. A `node_modules` inside
     `src-tauri/target/…/app.asar.unpacked/` is not listed, because `src-tauri/target/` is listed
     instead; a plain filesystem walk found that one. It took 29 ms on this repo.
   - Git lists a symlink named `node_modules` without a trailing slash, so it is dropped. Each
     result is also lstat-checked as a real directory, so a symlink is never followed. Paths with
     `..` or empty segments are dropped.
2. **Gate:** `cloneBlockedReason(src, destParent)` requires macOS, both paths on APFS
   (`statfs.type === 26`, measured on this machine; devfs is 19), and the same device. This gate is
   what guarantees "never a plain full copy":
   - `cp -c` does not fail when it cannot clone. Its man page says it falls back to copyfile(2), a
     full copy.
   - Node's `fs.cp`/`copyFile` with `COPYFILE_FICLONE_FORCE` would fail properly, but returned
     `ENOSYS` on this Mac even within one volume.
   - clonefile(2) works between any two paths on the same APFS volume, which is what the gate
     checks. A blocked directory is skipped without any copy being attempted.
3. **Clone:** `/bin/cp -cR <src> <dst>`, one child process per directory. It shares one 30 s total
   cap (`DEPENDENCY_CLONE_CAP_MS`) and is killed with SIGKILL when the cap runs out. After a failure
   or a kill, the partial tree inside the NEW worktree is removed; the source is never touched.
   Once the cap is used up, remaining directories are skipped. A destination that already exists is
   left alone. Symlinks inside the tree (e.g. `.bin/*`) are copied as symlinks, the way `cp -R`
   does.
4. **Nothing fails the worktree.** `cloneDependencies` never throws, so the worktree is always
   kept. The result is logged in main:
   `[worktree] <path>: cloned node_modules, electron/node_modules in N ms; not cloned: …`.
   It is also returned on `WorktreeCreateResult.dependencies` (`cloned`, `skipped`, `ms`, `note`).
5. **The lane sees one line** when something was skipped: `node_modules not cloned into this
   worktree: <rel> (<reason>); … Run npm install where you need it.` `handleLaunchSession` appends
   it to the lane's orchestration note, the system-prompt text it starts with.
   - The restore path (`handleRestoreSession`, rebuilding a suspended lane's worktree) passes no
     orchestration note today, so a skip there shows only in the main-process log.
   - There is no toast for the user.

The launch waits for the clone before the agent starts: about 1.7 s here (below), 30 s at most.

## Measured on this Mac

Throwaway repo in the scratchpad (same APFS Data volume as `/Users`). Its `node_modules` and
`electron/node_modules` are clones of this project's real ones: 13,869 entries, 180 MB + 486 MB by
`du`. Three consecutive `createWorktree` calls, with `sync` and `df -k` before and after each:

| Run | createWorktree | clone step | `df` used, delta |
|---|---|---|---|
| 1 | 1,858 ms | 1,770 ms | +6,244 KB |
| 2 | 1,732 ms | 1,658 ms | +6,076 KB |
| 3 | 1,798 ms | 1,721 ms | +5,004 KB |

`du` over the three worktrees reports 2,059,680 KB (about 686 MB each), because it counts every
cloned block as full. `df` shows about 5–6 MB per worktree, which is clone metadata plus the
checkout itself; the `df` figure includes other activity on the volume. In a cloned worktree,
`node_modules/.bin/vitest --version`, `tsc --version` and `electron/node_modules/.bin/electron
--version` all ran.

## Tests (`electron/src/main/worktree.test.ts`, sandbox)

- **Discovery:** root and nested (`electron/node_modules`) are found. Not found: a tracked
  `docs/node_modules`, a `node_modules` inside ignored `build/`, and a symlink `linked/node_modules`.
- **`createWorktree`, real clone (darwin only):**
  - both directories cloned as real directories, with the `.bin` symlink kept as a symlink;
  - the symlinked one and the build-output one absent;
  - `git status` clean in the worktree;
  - writing a cloned file does not change the source.
- **Clone failure:** a cloner that creates a partial tree and throws leaves no `node_modules` in the
  worktree, the source intact, and a note naming the reason and `npm install`.
- **Blocked volume:** the cloner is never called, and each directory is skipped with the reason.
- **Time cap:** a killed cloner is reported as "timed out"; later directories are skipped with
  "launch cap was reached".
- **Gate:** `/dev` is "not on an APFS volume"; the sandbox (APFS, same device) passes.

Results:
- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass.
- Electron suite: 32 files, 618 passed, 0 failed.
- Renderer suite (`vitest run src/renderer`): 83 files, 1266 passed, 0 failed.
- Run with the main checkout's `node_modules` and `electron/node_modules` symlinked into this
  worktree, removed after. Once this lands, a new lane worktree gets them cloned instead.

## Other build output: candidates, not cloned

Ignored directories git lists in this repo today (`git ls-files -oi --directory`), with `du` sizes
from the main checkout:

| Directory | Size (du) | Notes |
|---|---|---|
| `src-tauri/target/` | 36.4 GB | Rust build cache for the old Tauri shell. Cloning it would save a cold `cargo build` but nothing in the Electron lanes uses it. |
| `electron/out/` | 4.6 MB | Electron build output; rebuilt by the build. |
| `dist/` | 1.4 MB | Renderer build output. |
| `out/`, `scripts/visual/out/`, `scripts/width-audit/out/` | small | Script output. |
| `.vite` caches | none present today | Would appear under `node_modules/.vite`, which is already cloned with `node_modules`. |

If any of these are wanted, the same gate, cap and git listing apply, with the directory-name filter
widened. `src-tauri/target/` is the only one where a clone would save meaningful time, and it
matters only for work on the Tauri shell.

## Risks

- **The gate is the only protection against a full copy.** `cp -c` could in principle fall back per
  file even inside one APFS volume (for example, a file type clonefile refuses). I have not seen
  that happen, and the `df` measurement shows no full copy for these trees.
- **Launch waits for the clone,** 1.7 s here and 30 s at most on a very large tree. The clone runs
  before `worktreeCreate` returns, so fan-out launches clone once per worktree, one after another.
- **A cloned `node_modules` is a snapshot** of the main checkout's at launch. If the lane's branch
  changes dependencies, it still needs `npm install`, and that install writes only into the clone.
- **Non-macOS:** skipped with a note (`cloning needs APFS on macOS`); the app only ships for macOS
  today.
