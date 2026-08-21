// Which shell to run a command through, and why it is never `/bin/sh`.
//
// A GUI APP IS NOT LAUNCHED FROM A SHELL. macOS starts Operator from Finder/launchd with a
// minimal PATH, so anything the user installed into `~/.local/bin`, a Homebrew prefix, nvm, mise
// or asdf is invisible to it — including `claude` itself (`~/.zshrc:6` puts `~/.local/bin` on
// PATH). The only process that knows the user's real PATH is the user's own login shell, so
// every command Operator runs on the user's behalf goes through it.
//
// `/bin/sh -ilc` was the shipped 0.17.0 answer and it is the wrong one twice over: `sh -l` reads
// `~/.profile` and NEVER `~/.zshrc`, so PATH stays minimal ("sh: claude: command not found" on
// the Plan usage card), and `sh -i` with no tty adds "sh: no job control in this shell" on top.
//
// Ported from `planlimits.rs:278` / `lib.rs:929`, and the same rule `terminals.ts` already
// spawns lanes with — one place now, so the next call site cannot guess differently.
export function loginShell(): string {
  // Read at CALL time, not import time: `SHELL` is process env, and a test (or a relaunch under
  // a different shell) that sets it must be answered, not remembered from module load.
  return process.env.SHELL || '/bin/zsh'
}
