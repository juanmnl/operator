// Git worktree operations (port of worktree.ts). Each agent session can run in
// an isolated worktree under ~/.operator/worktrees, with in-app diff/merge/discard.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn worktree_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".operator").join("worktrees")
}

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

pub fn inspect_repo(cwd: &str) -> RepoInfo {
    match git(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => {
            let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
                .ok()
                .filter(|b| !b.is_empty() && b != "HEAD");
            RepoInfo { is_repo: true, root: Some(root), branch }
        }
        Err(_) => RepoInfo { is_repo: false, root: None, branch: None },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateResult {
    pub path: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
}

fn short_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("{:x}", nanos & 0xffffff)
}

/// THE BRANCH A NEW LANE FORKS FROM — the repository's default branch, resolved, never the
/// caller's `HEAD`.
///
/// `worktree add … HEAD` took the head of *the checkout that asked*. A coordinator sitting in its
/// own stale worktree therefore handed its staleness to every lane it launched, and each of those
/// lanes handed on whatever it had. Measured 2026-08-05: branches 30–137 commits behind main, 9
/// unmerged commits across 6 of them. That is the "stale branches get picked up" the user
/// reported. Part 1 of this change keeps the coordinator in the main repo, which makes the common
/// case correct; this removes the fragility itself, so a lane launched from anywhere — another
/// lane, a detached checkout, a worktree someone left open for a week — still starts from current
/// work.
///
/// TWO STEPS, AND THEY ARE DIFFERENT QUESTIONS. First the NAME of the default branch, which is a
/// property of the repository and is derived, never hardcoded: `origin/HEAD` is what a clone
/// records, and `main`/`master` are only the fallback for a repo with no remote (a fresh `git
/// init`, which is most tests and some real projects). Then the COMMIT-ISH to fork from, and for
/// that the LOCAL branch wins over `origin/<name>`:
///
///   this project merges lane branches into local `main` and pushes later, so `origin/main` can be
///   behind by exactly the work that was just merged. Forking from the remote ref would drop it —
///   the same defect in the other direction, and a subtler one, because the branch would look
///   current against the remote.
///
/// `None` when nothing resolves, and the caller then falls back to `HEAD`: a lane that starts from
/// a stale base is worse than one that starts from a current base, but both are better than a
/// launch that fails.
fn default_base(root: &str) -> Option<String> {
    // The name. `origin/HEAD` → `refs/remotes/origin/main` → `main`.
    let named = git(root, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|r| r.rsplit('/').next().map(str::to_string))
        .filter(|n| !n.is_empty());

    // Candidates in order of authority: what the remote says the default is, then the two
    // conventional names for a repo that has never had a remote.
    let candidates: Vec<String> = named
        .into_iter()
        .chain(["main".to_string(), "master".to_string()])
        .collect();

    for name in candidates {
        // A local branch of that name is the best base — it holds anything merged but not pushed.
        if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok() {
            return Some(name);
        }
        // Otherwise the remote-tracking ref, for a checkout that never made the local branch.
        let remote = format!("refs/remotes/origin/{name}");
        if git(root, &["rev-parse", "--verify", "--quiet", &remote]).is_ok() {
            return Some(format!("origin/{name}"));
        }
    }
    None
}

/// REATTACHING A SUSPENDED LANE TO ITS OWN BRANCH.
///
/// Task-scoped lanes remove the worktree DIRECTORY on close and keep the branch, so resuming one
/// has to put a directory back on the branch its thread thinks it is working in. Creating a fresh
/// branch instead would hand the resumed conversation a tree without its own committed work —
/// the transcript says "I edited X" and the file is back at base, which is worse than a cold start
/// because it looks correct.
///
/// `git worktree prune` first: a directory removed by anything other than `git worktree remove`
/// leaves an admin record behind, and that record alone makes `worktree add` refuse the branch as
/// already checked out.
///
/// `None` when the branch cannot be reattached (it does not exist, it is genuinely checked out
/// elsewhere, or the path is occupied). The caller then falls back to a fresh branch — a lane that
/// starts is better than one that does not, the same trade `default_base` makes.
fn reattach_worktree(root: &str, branch: &str) -> Option<WorktreeCreateResult> {
    git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).ok()?;
    let _ = git(root, &["worktree", "prune"]);

    // Same directory name as the lane had, when the branch carries our `operator/<short>` shape —
    // a lane that comes back at the path it left is one less thing that changed under it.
    let project = root.rsplit('/').next().unwrap_or("project").to_string();
    let short = branch.rsplit('/').next().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(short_id);
    let path = worktree_root().join(format!("{project}-{short}"));
    let path_str = path.to_string_lossy().to_string();
    if path.exists() {
        return None;
    }
    std::fs::create_dir_all(worktree_root()).ok()?;
    git(root, &["worktree", "add", &path_str, branch]).ok()?;
    Some(WorktreeCreateResult { path: path_str, branch: branch.to_string(), base_branch: default_base(root) })
}

/// Make a lane a worktree. `reuse_branch` names a branch a suspended lane left behind — see
/// `reattach_worktree`; anything else (or a reattach that cannot be done) creates a new one.
/// `lane_id` is whatever the caller knows about who this is for — the session does not exist yet
/// at launch, so it is the role id in practice, and it is only ever a label on the provenance
/// record (see `Provenance`).
pub fn create_worktree(
    source_cwd: &str,
    reuse_branch: Option<&str>,
    lane_id: Option<&str>,
) -> Result<WorktreeCreateResult, String> {
    let info = inspect_repo(source_cwd);
    let root = match (info.is_repo, info.root) {
        (true, Some(r)) => r,
        _ => return Err("Not a git repository".into()),
    };
    git(&root, &["rev-parse", "HEAD"])
        .map_err(|_| "Repository has no commits yet — make an initial commit before using worktrees".to_string())?;

    if let Some(existing) = reuse_branch.filter(|b| !b.trim().is_empty()) {
        if let Some(reattached) = reattach_worktree(&root, existing.trim()) {
            // A reattached lane is a directory we just made, exactly as much as a fresh one is.
            record_provenance_in(&provenance_file(), Provenance {
                path: reattached.path.clone(),
                created_at: now_ms(),
                created_by: "operator".into(),
                source_repo: root.clone(),
                branch: reattached.branch.clone(),
                lane_id: lane_id.map(str::to_string),
            });
            return Ok(reattached);
        }
    }

    let project = root.rsplit('/').next().unwrap_or("project").to_string();
    let short = short_id();
    let branch = format!("operator/{short}");
    let path = worktree_root().join(format!("{project}-{short}"));
    let path_str = path.to_string_lossy().to_string();

    std::fs::create_dir_all(worktree_root()).map_err(|e| e.to_string())?;
    // The resolved default branch, or `HEAD` if it cannot be resolved — see `default_base`. The
    // fallback is deliberate and is the old behaviour: a lane that starts is better than one that
    // does not.
    let base = default_base(&root);
    let base_ref = base.clone().unwrap_or_else(|| "HEAD".to_string());
    git(&root, &["worktree", "add", "-b", &branch, &path_str, &base_ref])?;

    // PROVENANCE, RECORDED HERE AND NOWHERE ELSE. Reaping later can only be as safe as the
    // evidence it has, and this is the one moment we know for certain that the directory is ours.
    record_provenance_in(&provenance_file(), Provenance {
        path: path_str.clone(),
        created_at: now_ms(),
        created_by: "operator".into(),
        source_repo: root.clone(),
        branch: branch.clone(),
        lane_id: lane_id.map(str::to_string),
    });

    // WHAT IT ACTUALLY FORKED FROM, which is not the same question as "what branch is the caller
    // on" — and that is what this field used to answer (`info.branch`). Now that the two can
    // differ by design, reporting the caller's branch would describe a fork that did not happen,
    // and the UI shows this as the lane's base in the diff/merge panel.
    Ok(WorktreeCreateResult { path: path_str, branch, base_branch: Some(base_ref) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub changes: usize,
    pub valid: bool,
}

pub fn worktree_status(path: &str) -> WorktreeStatus {
    match git(path, &["status", "--porcelain"]) {
        Ok(porcelain) => {
            let branch = git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| !b.is_empty());
            let changes = porcelain.lines().filter(|l| !l.is_empty()).count();
            WorktreeStatus { valid: true, branch, changes }
        }
        Err(_) => WorktreeStatus { valid: false, branch: None, changes: 0 },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub files: Vec<FileChange>,
    pub diff: String,
}

// Working-tree diff of `path`. Against HEAD by default; pass `base` (e.g. the worktree's
// base branch) to diff from the merge-base instead — that spans the lane's COMMITTED work
// too, not just uncommitted edits (an agent that commits would otherwise read "no changes").
pub fn worktree_diff(path: &str, base: Option<&str>) -> WorktreeDiff {
    let against: String = base
        .and_then(|b| git(path, &["merge-base", b, "HEAD"]).ok())
        .unwrap_or_else(|| "HEAD".into());
    let branch = git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let porcelain = git(path, &["status", "--porcelain"]).unwrap_or_default();

    let mut files: Vec<FileChange> = vec![];
    let mut untracked: Vec<String> = vec![];
    for line in porcelain.lines() {
        if line.is_empty() {
            continue;
        }
        let status = line.chars().take(2).collect::<String>();
        let file = line[3..].trim().to_string();
        if status == "??" {
            untracked.push(file.clone());
        }
        files.push(FileChange { path: file, status, added: 0, removed: 0 });
    }

    if let Ok(numstat) = git(path, &["diff", &against, "--numstat"]) {
        for line in numstat.lines() {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() == 3 {
                if let Some(entry) = files.iter_mut().find(|f| f.path == cols[2]) {
                    entry.added = cols[0].parse().unwrap_or(0);
                    entry.removed = cols[1].parse().unwrap_or(0);
                } else {
                    // Committed-but-clean files don't appear in porcelain — add them so a
                    // base-relative diff still lists the lane's committed work.
                    files.push(FileChange {
                        path: cols[2].to_string(),
                        status: "M ".into(),
                        added: cols[0].parse().unwrap_or(0),
                        removed: cols[1].parse().unwrap_or(0),
                    });
                }
            }
        }
    }

    let mut diff = git(path, &["diff", &against, "--no-color"]).unwrap_or_default();

    // Synthetic +diff for untracked files so new file contents show too.
    for u in &untracked {
        let content = std::fs::read_to_string(format!("{path}/{u}")).unwrap_or_default();
        let lines = content.lines().count().max(1);
        let header = format!("diff --git a/{u} b/{u}\nnew file\n--- /dev/null\n+++ b/{u}\n@@ -0,0 +1,{lines} @@\n");
        let body = content.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n");
        if !diff.is_empty() {
            diff.push('\n');
        }
        diff.push_str(&header);
        diff.push_str(&body);
        if let Some(entry) = files.iter_mut().find(|f| &f.path == u) {
            entry.added = lines as u32;
        }
    }

    WorktreeDiff { branch, files, diff }
}

// Diff a (surviving) branch against its base from the SOURCE repo — the durable
// fallback for a task's diff after its worktree directory has been removed
// (close keeps the branch). Three-dot: base..merge-base..branch, i.e. only what
// the lane committed, not what base gained since.
pub fn branch_diff(source_root: &str, branch: &str, base_branch: &str) -> WorktreeDiff {
    let range = format!("{base_branch}...{branch}");
    let mut files: Vec<FileChange> = vec![];
    if let Ok(status) = git(source_root, &["diff", &range, "--name-status"]) {
        for line in status.lines() {
            let mut cols = line.split('\t');
            if let (Some(st), Some(path)) = (cols.next(), cols.next_back()) {
                files.push(FileChange { path: path.trim().to_string(), status: st.trim().to_string(), added: 0, removed: 0 });
            }
        }
    }
    if let Ok(numstat) = git(source_root, &["diff", &range, "--numstat"]) {
        for line in numstat.lines() {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() == 3 {
                if let Some(entry) = files.iter_mut().find(|f| f.path == cols[2]) {
                    entry.added = cols[0].parse().unwrap_or(0);
                    entry.removed = cols[1].parse().unwrap_or(0);
                }
            }
        }
    }
    let diff = git(source_root, &["diff", &range, "--no-color"]).unwrap_or_default();
    WorktreeDiff { branch: Some(branch.to_string()), files, diff }
}

// =============================================================================
// REAPING — phase 1: the mechanics, behind a dry run that deletes nothing.
//
// `~/.operator/worktrees` had grown to 70 directories / 21GB because nobody owns retirement.
// The machinery below is what a reaper needs before it is allowed to delete anything: guard
// rails, a proof that a directory really is ours, provenance recorded at creation, and deferred
// deletion. Ported from Orca (MIT) — the rules are theirs, the failure modes each rule prevents
// are real bugs we would otherwise have discovered by losing the user's work.
//
// WHAT THIS PHASE DELIBERATELY DOES NOT DO: decide when a HEALTHY worktree retires, and delete
// anything at all outside a test. `ReapMode::Execute` exists so the mechanics can be proven by
// the test suite; every caller in the app passes `ReapMode::DryRun`.
// =============================================================================

/// Whether a reaping operation may touch the filesystem. Phase 1 ships `DryRun` at every call
/// site — the mode is a parameter rather than a global so there is no flag to flip by accident.
#[allow(dead_code)] // `Execute` has no production caller in phase 1 — the tests are what exercise it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReapMode {
    DryRun,
    Execute,
}

// --- Lexical path safety -----------------------------------------------------
// Every comparison here is LEXICAL — no `canonicalize`, because these run against paths that may
// already be half-deleted, and a resolve that touches the filesystem answers "does not exist"
// instead of "would be catastrophic to delete".

/// A path split into components with `.` dropped and `..` popped, the way `path.resolve` does it.
/// Relative input is anchored to the cwd. An empty vec IS the filesystem root.
///
/// Popping `..` lexically is what separates `..` from `..name`: the first escapes the parent, the
/// second is an ordinary directory whose name happens to start with two dots. String-prefix
/// containment gets that wrong in both directions.
fn lexical_components(input: &str) -> Vec<String> {
    let raw = Path::new(input);
    let joined: PathBuf = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(raw)
    };
    let mut out: Vec<String> = vec![];
    for c in joined.components() {
        match c {
            Component::Prefix(p) => out.push(p.as_os_str().to_string_lossy().into_owned()),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s.to_string_lossy().into_owned()),
        }
    }
    out
}

fn lexical(input: &str) -> String {
    format!("/{}", lexical_components(input).join("/"))
}

/// The same components with SYMLINKS RESOLVED as far as the path actually exists, and the rest
/// kept lexical.
///
/// Not an optimisation — a correctness requirement. git writes fully resolved paths into `.git`
/// files and reports them from `worktree list`, so on macOS the admin entry says
/// `/private/var/…/x` for a directory the caller knows as `/var/…/x`. Compared lexically those are
/// two different places: the ownership proof fails on a worktree that is plainly ours, and the
/// nested-worktree refusal misses a nesting that is plainly there.
///
/// The tail has to stay lexical because the interesting paths are the ones that no longer exist —
/// a pruned admin entry, a directory queued for deletion — and `canonicalize` on those answers
/// "not found" rather than an address.
fn resolved_components(input: &str) -> Vec<String> {
    let comps = lexical_components(input);
    let mut head = comps.clone();
    let mut tail: Vec<String> = vec![];
    while !head.is_empty() {
        if let Ok(real) = std::fs::canonicalize(format!("/{}", head.join("/"))) {
            let mut out = lexical_components(&real.to_string_lossy());
            out.extend(tail.into_iter().rev());
            return out;
        }
        tail.push(head.pop().unwrap_or_default());
    }
    comps
}

fn resolved(input: &str) -> String {
    format!("/{}", resolved_components(input).join("/"))
}

/// macOS and Windows filesystems are case-insensitive by default, so `/Users/X/Repo` and
/// `/users/x/repo` are the same directory and a case-sensitive guard rail would wave one through.
fn same_component(a: &str, b: &str) -> bool {
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn same_path(a: &str, b: &str) -> bool {
    let (a, b) = (resolved_components(a), resolved_components(b));
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| same_component(x, y))
}

/// True when `child` is `parent` or lives underneath it.
fn contains_path(parent: &str, child: &str) -> bool {
    let (p, c) = (resolved_components(parent), resolved_components(child));
    c.len() >= p.len() && p.iter().zip(c.iter()).all(|(x, y)| same_component(x, y))
}

/// Components of `child` below `parent`, or `None` when it is not underneath.
fn relative_components(parent: &str, child: &str) -> Option<Vec<String>> {
    let (p, c) = (resolved_components(parent), resolved_components(child));
    if c.len() < p.len() || !p.iter().zip(c.iter()).all(|(x, y)| same_component(x, y)) {
        return None;
    }
    Some(c[p.len()..].to_vec())
}

/// THE PATHS THAT MAY NEVER BE RECURSIVELY DELETED, whatever else says they can be. Returns the
/// reason so a refusal can be reported rather than silently swallowed.
///
/// Each rule is a bug we do not have to discover for ourselves: a caller that passes an empty
/// string deletes the cwd, one that passes the repo deletes the project, and `worktree` = a path
/// that CONTAINS the repo deletes the project plus everything beside it. `repo` may be `None`
/// when the owning repository is unknown (a stranded directory) — the rules that do not need it
/// still apply.
pub fn dangerous_removal_reason(worktree_path: &str, repo: Option<&str>) -> Option<String> {
    if worktree_path.trim().is_empty() {
        return Some("path is empty".into());
    }
    if let Some(repo) = repo {
        if same_path(worktree_path, repo) {
            return Some("path is the repository itself".into());
        }
    }
    let comps = resolved_components(worktree_path);
    if comps.is_empty() {
        return Some("path is the filesystem root".into());
    }
    let here = resolved(worktree_path);
    if let Some(repo) = repo {
        if contains_path(worktree_path, repo) {
            return Some(format!("path contains the repository ({})", resolved(repo)));
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.trim().is_empty() && contains_path(worktree_path, &home) {
        return Some(format!("path contains $HOME ({})", resolved(&home)));
    }
    // The home-shaped rules are about the NAME the caller asked for, so they run on the literal
    // path as well as the resolved one. macOS firmlinks `/home` to `/System/Volumes/Data/home`,
    // and a rule that only looked at the resolved form would wave `/home` straight through.
    for form in [lexical(worktree_path), here.clone()] {
        if form == "/home" || form == "/root" {
            return Some(format!("path is {form}"));
        }
        let c = lexical_components(&form);
        if c.len() == 2 && (same_component(&c[0], "home") || same_component(&c[0], "Users")) {
            return Some(format!("path is a user home directory ({form})"));
        }
    }
    None
}

/// WHAT A NESTING CHECK IS ALLOWED TO SAY. Three answers, not two.
///
/// The first version of this returned `Option<String>`, and `None` meant four different things:
/// the walk finished · it gave up at a budget · it never looked past a depth limit · it could not
/// open a directory. Three of those are "I do not know" wearing the costume of "nothing is
/// nested". A bound that cannot be reported is a bound that lies, and the lie is in the direction
/// of deletion — so `Unknown` exists and every caller refuses on it.
#[derive(Debug, PartialEq, Eq)]
pub enum Nesting {
    Clean,
    Nested(String),
    Unknown(String),
}

/// Registered worktree paths of `repo`, straight from git. An `Err` when git cannot answer, which
/// is the whole point: the previous version returned an empty list, and an empty list read as
/// "nothing is nested" to every caller.
fn registered_worktrees(repo: &str) -> Result<Vec<String>, String> {
    git(repo, &["worktree", "list", "--porcelain"]).map(|out| {
        out.lines()
            .filter_map(|l| l.strip_prefix("worktree ").map(|p| p.trim().to_string()))
            .collect()
    })
}

/// REFUSE TO REMOVE A WORKTREE THAT CONTAINS ANOTHER ONE. `git worktree remove --force` treats a
/// nested worktree as an ordinary untracked directory: it deletes the working files and leaves
/// git a prunable child record, so the loss is silent in both directions — the files are gone and
/// git does not think anything happened.
///
/// This can only see worktrees of `repo`, which is why it is never used alone: a lane that checked
/// out a DIFFERENT project inside its own directory is invisible to `git worktree list` here. See
/// `nested_checkout`.
fn nested_registered_worktree(worktree_path: &str, repo: &str) -> Nesting {
    match registered_worktrees(repo) {
        Err(e) => Nesting::Unknown(format!("`git worktree list` failed in {repo}: {e}")),
        Ok(list) => match list.iter().find(|p| !same_path(p, worktree_path) && contains_path(worktree_path, p)) {
            Some(p) => Nesting::Nested(p.clone()),
            None => Nesting::Clean,
        },
    }
}

// --- Bidirectional gitdir proof ----------------------------------------------

/// What `<worktree>/.git` proves about who owns the directory.
#[derive(Debug, PartialEq, Eq)]
pub enum GitdirProof {
    /// All three links hold and the admin entry points back here: a live worktree of this repo.
    /// Removal goes through `git worktree remove`, never a raw recursive delete.
    Registered,
    /// The repository ANSWERED — it resolved its own admin directory — and the entry for this
    /// candidate is gone from it. Git pruned it; nothing can still own the directory.
    Orphan,
    /// The repository could not be asked, so nothing here is proved. See `RepoAbsence`.
    RepoUnreachable { repo: String, why: RepoAbsence },
    /// The admin entry exists and back-references a DIFFERENT directory. A copied `.git` file
    /// looks exactly like the real thing up to this point; only the back-reference catches it.
    Foreign { admin: String, points_at: String },
    /// No `.git` at all — the proof cannot run, and provenance is the only remaining evidence.
    NoMarker,
    Malformed(String),
}

/// WHY THE REPOSITORY COULD NOT BE ASKED, and the two are not the same claim.
///
/// `Path::exists()` answers `false` for every error, which is how the first version concluded
/// "deleted" from a `chmod 000` on a parent directory, an unmounted volume, a network share that
/// had not come back, or a dangling symlink. `boot_sweep` runs at app start — precisely when
/// volumes have not remounted — and the repositories in question live under `~/Documents`, a
/// TCC-protected folder this project has a documented, intermittent access problem with.
///
/// `prove_gitdir` already draws exactly this distinction for the WORKTREE's own `.git`, and
/// refuses on anything that is not a clean `NotFound`, on the grounds that broken is not the same
/// as absent. This applies the same standard to the repo.
#[derive(Debug, PartialEq, Eq)]
pub enum RepoAbsence {
    /// A clean `NotFound`. Still not proof of deletion — a MOVED repository looks exactly like
    /// this from the candidate's side, keeps a live back-reference, and `git worktree repair`
    /// puts it back in one command — which is why `Absent` never authorises a delete either.
    Absent,
    /// Anything else. We were not allowed to look, or could not.
    Unknown(String),
}

#[derive(Debug, PartialEq, Eq)]
enum RepoPresence {
    Present,
    Absent,
    Unknown(String),
}

fn repo_presence(repo: &str) -> RepoPresence {
    match std::fs::symlink_metadata(repo) {
        Ok(_) => RepoPresence::Present,
        Err(ref e) if is_missing(e) => RepoPresence::Absent,
        Err(e) => RepoPresence::Unknown(format!("{e}")),
    }
}

fn is_missing(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::NotFound) || e.raw_os_error() == Some(20) // ENOTDIR
}

fn parse_gitdir_line(contents: &str) -> Option<String> {
    let first = contents.lines().next()?.trim();
    let rest = first.get(..7).filter(|p| p.eq_ignore_ascii_case("gitdir:"))?;
    let _ = rest;
    let value = first[7..].trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn first_line_path(contents: &str) -> Option<String> {
    let first = contents.lines().next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// Resolve a gitdir value, which git writes as either absolute or relative to the file holding it.
fn resolve_against(value: &str, base: &Path) -> String {
    if Path::new(value).is_absolute() {
        lexical(value)
    } else {
        lexical(&base.join(value).to_string_lossy())
    }
}

/// Where `<repo>` keeps its linked-worktree admin entries. Usually `<repo>/.git/worktrees`, but a
/// repo can itself BE a linked worktree (Operator launches lanes from lanes), in which case its
/// `.git` is a file and its siblings live next to its own admin entry. A separate git dir can also
/// sit under a directory called `worktrees` by coincidence — only the admin backlink tells the two
/// apart.
fn repo_worktrees_dir(repo: &str) -> Option<String> {
    let repo_git = Path::new(repo).join(".git");
    let md = std::fs::symlink_metadata(&repo_git).ok()?;
    if !md.is_file() {
        return Some(lexical(&repo_git.join("worktrees").to_string_lossy()));
    }
    let contents = std::fs::read_to_string(&repo_git).ok()?;
    let gitdir = parse_gitdir_line(&contents)?;
    let resolved = resolve_against(&gitdir, Path::new(repo));
    let parent = Path::new(&resolved).parent()?.to_string_lossy().to_string();
    let parent_name = Path::new(&parent).file_name()?.to_string_lossy().to_string();
    if parent_name == "worktrees" {
        let back = std::fs::read_to_string(Path::new(&resolved).join("gitdir"))
            .ok()
            .and_then(|c| first_line_path(&c))
            .map(|p| resolve_against(&p, Path::new(&resolved)));
        if back.is_some_and(|b| same_path(&b, &repo_git.to_string_lossy())) {
            return Some(parent);
        }
    }
    Some(lexical(&Path::new(&resolved).join("worktrees").to_string_lossy()))
}

/// PROVE, BOTH WAYS, THAT A DIRECTORY IS THIS REPO'S WORKTREE — before any recursive delete.
///
/// 1. `<worktree>/.git` must be a FILE containing `gitdir: <path>`
/// 2. that path must be a DIRECT child of `<repo>/.git/worktrees/` (one level, no nesting)
/// 3. `<gitdir>/gitdir` must point BACK at `<worktree>/.git`
///
/// Step 3 is the one that matters. A `.git` file copied out of another worktree satisfies 1 and 2
/// perfectly while naming someone else's admin entry; the back-reference is the only thing that
/// says the entry still belongs to THIS directory. When the admin entry has vanished entirely
/// there is no back-reference to read and also no other owner to harm — that is `Orphan`.
///
/// ALL THREE STEPS NEED THE REPOSITORY TO ANSWER. Step 2 resolves `<repo>/.git/worktrees` by
/// asking the repo, and that is the only part of this corroborated by something the candidate does
/// not control. A repo that cannot be reached therefore ends the proof at `RepoUnreachable`
/// instead of continuing on reconstructed values — see the comment at that branch.
pub fn prove_gitdir(worktree_path: &str, repo: &str) -> GitdirProof {
    let git_marker = Path::new(worktree_path).join(".git");
    let md = match std::fs::symlink_metadata(&git_marker) {
        Ok(md) => md,
        Err(ref e) if is_missing(e) => return GitdirProof::NoMarker,
        Err(e) => return GitdirProof::Malformed(format!("cannot stat .git: {e}")),
    };
    if md.file_type().is_symlink() {
        return GitdirProof::Malformed(".git is a symlink".into());
    }
    if !md.is_file() {
        return GitdirProof::Malformed(".git is a directory — a repository, not a worktree".into());
    }
    let contents = match std::fs::read_to_string(&git_marker) {
        Ok(c) => c,
        Err(e) => return GitdirProof::Malformed(format!("cannot read .git: {e}")),
    };
    let Some(gitdir) = parse_gitdir_line(&contents) else {
        return GitdirProof::Malformed(".git has no `gitdir:` line".into());
    };
    let resolved = resolve_against(&gitdir, Path::new(worktree_path));

    // EVERYTHING PAST THIS POINT NEEDS THE REPOSITORY TO ANSWER, and when it cannot, this stops.
    //
    // The previous version reconstructed `<repo>/.git/worktrees` from the very gitdir string it
    // was about to validate, which made step 2 unable to disagree, and then read step 3's file at
    // a path named by that same string — absent, because the repo is absent. Three links, one
    // source, all of it content read out of the candidate itself. That is not a bidirectional
    // proof; it is a restatement of step 1's premise, and it was the only branch that authorised a
    // delete. It now returns `RepoUnreachable`, which no sweep may act on.
    let worktrees_dir = match repo_worktrees_dir(repo) {
        Some(d) => d,
        None => {
            let why = match repo_presence(repo) {
                // The directory is there but will not tell us where its admin entries live —
                // a broken repository, not an absent one. Unchanged: refuse.
                RepoPresence::Present => {
                    return GitdirProof::Malformed(format!("cannot resolve {repo}/.git/worktrees"))
                }
                RepoPresence::Absent => RepoAbsence::Absent,
                RepoPresence::Unknown(e) => RepoAbsence::Unknown(e),
            };
            return GitdirProof::RepoUnreachable { repo: repo.to_string(), why };
        }
    };
    match relative_components(&worktrees_dir, &resolved) {
        Some(rel) if rel.len() == 1 => {}
        _ => {
            return GitdirProof::Malformed(format!(
                "gitdir {resolved} is not a direct child of {worktrees_dir}"
            ))
        }
    }

    let admin_gitdir = Path::new(&resolved).join("gitdir");
    match std::fs::read_to_string(&admin_gitdir) {
        Ok(text) => {
            let Some(back) = first_line_path(&text) else {
                return GitdirProof::Malformed("admin gitdir is empty".into());
            };
            let back = resolve_against(&back, Path::new(&resolved));
            if same_path(&back, &git_marker.to_string_lossy()) {
                GitdirProof::Registered
            } else {
                GitdirProof::Foreign { admin: resolved, points_at: back }
            }
        }
        Err(ref e) if is_missing(e) => match std::fs::symlink_metadata(&resolved) {
            // The whole admin entry is gone: git has already pruned it, so no live worktree can
            // still claim this directory.
            Err(ref e) if is_missing(e) => GitdirProof::Orphan,
            _ => GitdirProof::Malformed(format!("admin entry {resolved} exists but has no gitdir")),
        },
        Err(e) => GitdirProof::Malformed(format!("cannot read admin gitdir: {e}")),
    }
}

/// The repository a `.git` file names, read out of the gitdir path shape rather than asked of git
/// — for an orphan there is no admin entry left to ask. Only a hint: whatever comes back is fed
/// straight into `prove_gitdir`, which re-derives the same path independently.
fn repo_hint_from_marker(worktree_path: &str) -> Option<String> {
    let contents = std::fs::read_to_string(Path::new(worktree_path).join(".git")).ok()?;
    let resolved = resolve_against(&parse_gitdir_line(&contents)?, Path::new(worktree_path));
    let comps = lexical_components(&resolved);
    // <repo>/.git/worktrees/<name>
    if comps.len() >= 4 && comps[comps.len() - 2] == "worktrees" && comps[comps.len() - 3] == ".git" {
        return Some(format!("/{}", comps[..comps.len() - 3].join("/")));
    }
    None
}

// --- Provenance --------------------------------------------------------------

/// WHAT WE MADE, RECORDED WHEN WE MAKE IT. Path shape is not authority: the user can put their own
/// git worktrees in `~/.operator/worktrees`, and a reaper that globs the directory would eat them.
///
/// It lives beside `sessions.json` rather than inside the worktree on purpose — the case it has to
/// answer is a directory that has already lost its `.git`, and anything stored inside it is gone
/// by then too.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub path: String,
    pub created_at: u64,
    pub created_by: String,
    pub source_repo: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub lane_id: Option<String>,
}

fn provenance_file() -> PathBuf {
    // The suite exercises `create_worktree`, which records — and must never write the user's real
    // store with tempdir paths that will be gone a second later.
    if cfg!(test) {
        return std::env::temp_dir().join("operator-test-worktree-provenance.json");
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".operator").join("worktree-provenance.json")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load_provenance_from(store: &Path) -> Vec<Provenance> {
    std::fs::read_to_string(store).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Same crash-safe temp+rename contract as `sessions.json`: a half-written provenance file would
/// make every worktree it described unreapable, which is the safe direction but still a leak.
fn record_provenance_in(store: &Path, entry: Provenance) {
    let mut all = load_provenance_from(store);
    all.retain(|p| !same_path(&p.path, &entry.path));
    all.push(entry);
    if let Some(dir) = store.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&all) {
        let tmp = store.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, store);
        }
    }
}

fn provenance_for(store: &Path, path: &str) -> Option<Provenance> {
    load_provenance_from(store).into_iter().find(|p| same_path(&p.path, path))
}

// --- Is anybody working in there? ---------------------------------------------

/// THE SESSION REGISTRY, WHICH NOTHING WAS ASKING. `sessions.json` sits beside the provenance
/// store and records every lane's working directory; 22 of 46 records point at a worktree. Chain
/// that gap with any wrong absence verdict and the failure is a running agent's checkout deleted
/// underneath it mid-turn. Operator hit this by hand: 3 of 15 candidates in a manual pass were
/// live lane worktrees.
///
/// SUSPENDED SESSIONS COUNT TOO, deliberately. A suspended lane's directory is exactly the thing
/// resume rebuilds and reattaches, so a record pointing at it is a claim on it whether or not a
/// pty is alive right now.
struct SessionIndex {
    cwds: Vec<String>,
    /// Set when the registry could not be read or parsed. Callers refuse — "I could not check
    /// whether anyone is working here" is not "nobody is".
    unknown: Option<String>,
}

fn sessions_file() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".operator").join("sessions.json")
}

fn load_sessions(path: &Path) -> SessionIndex {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        // No registry at all is a legitimate state (a fresh profile), and it really does mean no
        // sessions. Any OTHER read error does not.
        Err(ref e) if is_missing(e) => return SessionIndex { cwds: vec![], unknown: None },
        Err(e) => {
            return SessionIndex { cwds: vec![], unknown: Some(format!("cannot read {}: {e}", path.display())) }
        }
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return SessionIndex { cwds: vec![], unknown: Some(format!("{} is not valid JSON", path.display())) };
    };
    // Bare array today; `{ "sessions": [...] }` is the shape `mcp.rs` also tolerates.
    let list = v.as_array().cloned().or_else(|| v.get("sessions")?.as_array().cloned());
    let Some(list) = list else {
        return SessionIndex { cwds: vec![], unknown: Some(format!("{} holds no session list", path.display())) };
    };
    let cwds = list
        .iter()
        .filter_map(|s| s.get("cwd").and_then(serde_json::Value::as_str))
        .filter(|c| !c.trim().is_empty())
        .map(str::to_string)
        .collect();
    SessionIndex { cwds, unknown: None }
}

impl SessionIndex {
    /// A recorded working directory that is `candidate` or sits inside it.
    fn claim_on(&self, candidate: &str) -> Option<&str> {
        self.cwds.iter().find(|c| contains_path(candidate, c)).map(String::as_str)
    }
}

// --- Deferred deletion: rename now, delete later ------------------------------

// NOTHING IN THIS SECTION HAS A PRODUCTION CALLER YET, hence the `dead_code` allows: switching the
// live removal path (`remove_worktree`) onto deferred deletion is a behaviour change that cannot be
// validated under a brief that forbids deleting anything, so it is phase 2. The machinery is built
// and proved by the suite now so that phase 2 is a wiring change and not a design.

const TRASH_DIR_NAME: &str = ".operator-worktree-trash";

/// A HIDDEN SIBLING of the worktree, so the rename can never cross a volume — the whole point of
/// deferring is that the expensive part happens after the caller has returned, and a cross-volume
/// rename is a copy.
fn trash_root_for(worktree_path: &Path) -> PathBuf {
    worktree_path.parent().unwrap_or(Path::new("/")).join(TRASH_DIR_NAME)
}

/// `wt-<epoch-ms>-<8 hex>`. The nonce is what keeps two concurrent removals of same-named
/// worktrees from landing on the same trash entry; it is derived rather than random because a
/// dependency for 4 bytes of entropy is not worth it and a collision only needs to be improbable
/// within one millisecond.
#[allow(dead_code)]
fn trash_entry_name(seed: &str) -> String {
    use std::hash::{Hash, Hasher};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut h);
    COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed).hash(&mut h);
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0).hash(&mut h);
    format!("wt-{}-{:08x}", now_ms(), h.finish() as u32)
}

/// The sweep only ever deletes entries it can prove it named. That pattern match IS the safety.
pub fn is_trash_entry_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("wt-") else { return false };
    let Some((ms, nonce)) = rest.rsplit_once('-') else { return false };
    !ms.is_empty()
        && ms.bytes().all(|b| b.is_ascii_digit())
        && nonce.len() == 8
        && nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Move a worktree aside so the caller can return before the recursive delete runs. `None` when
/// the rename is unavailable and the caller must delete in place instead — and in that case the
/// trash root we just made is removed again, so a failed deferral leaves nothing behind.
#[allow(dead_code)]
pub fn move_to_trash(worktree_path: &Path, mode: ReapMode) -> Option<PathBuf> {
    let root = trash_root_for(worktree_path);
    if mode == ReapMode::DryRun {
        println!("[worktree:dry-run] would move {} into {}", worktree_path.display(), root.display());
        return None;
    }
    let target = root.join(trash_entry_name(&worktree_path.to_string_lossy()));
    if std::fs::create_dir_all(&root).is_ok() {
        match std::fs::symlink_metadata(&root) {
            Ok(md) if md.is_dir() && !md.file_type().is_symlink() => {
                if std::fs::rename(worktree_path, &target).is_ok() {
                    return Some(target);
                }
            }
            _ => {}
        }
    }
    // `remove_dir` and not `remove_dir_all`: entries queued by an earlier removal are still
    // waiting in there, and this failure is not a reason to take them with us.
    let _ = std::fs::remove_dir(&root);
    None
}

/// Undo the rename when the bookkeeping that follows it fails. Block, don't orphan.
#[allow(dead_code)]
pub fn restore_from_trash(trash_path: &Path, worktree_path: &Path) -> bool {
    std::fs::rename(trash_path, worktree_path).is_ok()
}

/// Background deletes run ONE AT A TIME through a single worker, so a burst of removals cannot
/// saturate disk I/O while the user keeps working.
#[allow(dead_code)]
fn trash_worker() -> std::sync::MutexGuard<'static, std::sync::mpsc::Sender<PathBuf>> {
    static TX: std::sync::OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<PathBuf>>> =
        std::sync::OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
        std::thread::spawn(move || {
            for path in rx {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    // A warning and no more: the directory is already invisible to the user, and
                    // the boot sweep retries it.
                    eprintln!("[worktree] failed to delete trashed worktree {}: {e}", path.display());
                }
            }
        });
        std::sync::Mutex::new(tx)
    })
    .lock()
    .unwrap_or_else(|e| e.into_inner())
}

#[allow(dead_code)]
pub fn schedule_trash_deletion(trash_path: PathBuf, mode: ReapMode) {
    if mode == ReapMode::DryRun {
        println!("[worktree:dry-run] would delete trashed entry {}", trash_path.display());
        return;
    }
    let _ = trash_worker().send(trash_path);
}

/// Trash entries a previous run left behind — a crash or a kill mid-delete. Bounded so the scan
/// stays cheap however many directories the root is holding.
const TRASH_SWEEP_MAX_ENTRIES: usize = 200;

pub fn sweep_trash(roots: &[PathBuf], mode: ReapMode) -> usize {
    let mut removed = 0usize;
    for root in roots {
        let md = match std::fs::symlink_metadata(root) {
            Ok(md) => md,
            Err(_) => continue,
        };
        if !md.is_dir() || md.file_type().is_symlink() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root) else { continue };
        for entry in entries.flatten().take(TRASH_SWEEP_MAX_ENTRIES) {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_trash_entry_name(&name) {
                continue;
            }
            if mode == ReapMode::DryRun {
                println!("[worktree:dry-run] would sweep {}", entry.path().display());
                removed += 1;
                continue;
            }
            match std::fs::remove_dir_all(entry.path()) {
                Ok(()) => removed += 1,
                Err(e) => eprintln!("[worktree] failed to sweep {}: {e}", entry.path().display()),
            }
        }
    }
    removed
}

/// Called once at app start, fire-and-forget. DRY RUN in phase 1: it reports what a real sweep
/// would take and touches nothing.
pub fn boot_sweep() {
    std::thread::spawn(|| {
        let roots = vec![trash_root_for(&worktree_root().join("any"))];
        let n = sweep_trash(&roots, ReapMode::DryRun);
        if n > 0 {
            println!("[worktree:dry-run] boot sweep: {n} leftover entr(ies) would be deleted");
        }
    });
}

// --- The reaper: classify, decide, report -------------------------------------

/// Caps on the two recursive walks. A single lane checkout is routinely a few hundred thousand
/// files (node_modules), and neither the size report nor the nesting check is worth an unbounded
/// scan of the user's disk.
const WALK_MAX_ENTRIES: usize = 400_000;
/// Sized so the walk COMPLETES on a realistic checkout rather than bailing into `Unknown`. Review
/// measured this project's fully built main checkout at 122,494 entries to depth 6 alone
/// (`src-tauri/target` by itself is 159,386), against an old cap of 20,000 — so one `cargo build`
/// in a lane silently switched the nesting refusal off. The cost of the higher ceiling is paid
/// only when there is nothing nested, because the walk returns the moment it finds a marker.
const NEST_MAX_DEPTH: usize = 32;
const NEST_MAX_ENTRIES: usize = 1_000_000;

fn dir_size(path: &Path) -> (u64, bool) {
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > WALK_MAX_ENTRIES {
                return (total, true);
            }
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => stack.push(entry.path()),
                Ok(ft) if ft.is_file() => total += entry.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    (total, false)
}

/// A CHECKOUT NESTED INSIDE THE CANDIDATE, found without asking git — the reaper's candidates
/// often have no repo left to ask, and git can only ever see worktrees of one repository anyway.
///
/// TWO MARKERS, NOT ONE. A linked worktree leaves a `.git` FILE holding a `gitdir:` line. A plain
/// `git clone` — a vendored dependency, a scratch checkout, anything a lane cloned — leaves a
/// `.git` DIRECTORY, and that is the more damaging of the two to delete: a nested worktree loses
/// uncommitted work, but a nested clone's object store is the only copy of its unpushed commits.
/// The first version of this checked `is_file()` only, so the worse case was the unchecked one.
///
/// NOTHING IS SKIPPED BY NAME. `node_modules` used to be skipped for cost, which quietly meant a
/// worktree linked inside it (pnpm workspaces make real directories) was never looked at, reported
/// as clean. Running out of budget is now `Unknown`, which refuses — the honest version of the
/// same trade.
fn nested_checkout(path: &Path) -> Nesting {
    nested_checkout_within(path, NEST_MAX_ENTRIES, NEST_MAX_DEPTH)
}

/// The walk with its bounds as parameters, so the tests can reach the caps without building a
/// million files to do it.
fn nested_checkout_within(path: &Path, max_entries: usize, max_depth: usize) -> Nesting {
    // A directory that is not there cannot contain anything. Only the ROOT gets this treatment:
    // a subdirectory that vanishes mid-walk is a race, and a race is not an answer.
    if std::fs::symlink_metadata(path).is_err_and(|e| is_missing(&e)) {
        return Nesting::Clean;
    }
    let mut seen = 0usize;
    let mut stack = vec![(path.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => return Nesting::Unknown(format!("cannot read {}: {e}", dir.display())),
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => return Nesting::Unknown(format!("cannot list {}: {e}", dir.display())),
            };
            seen += 1;
            if seen > max_entries {
                return Nesting::Unknown(format!("gave up after {max_entries} entries under {}", path.display()));
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(e) => return Nesting::Unknown(format!("cannot stat {}: {e}", entry.path().display())),
            };
            if depth > 0 && name == ".git" {
                if ft.is_dir() {
                    return Nesting::Nested(format!("{} (a repository)", dir.display()));
                }
                if ft.is_file() {
                    match std::fs::read_to_string(entry.path()) {
                        Ok(c) if parse_gitdir_line(&c).is_some() => {
                            return Nesting::Nested(format!("{} (a linked worktree)", dir.display()))
                        }
                        Ok(_) => {}
                        Err(e) => {
                            return Nesting::Unknown(format!("cannot read {}: {e}", entry.path().display()))
                        }
                    }
                }
            }
            // `.git` is never descended into — it is enormous and holds nothing we are looking
            // for — but it is now always LOOKED AT, above, which is the difference that matters.
            if ft.is_dir() && name != ".git" {
                if depth + 1 > max_depth {
                    return Nesting::Unknown(format!("stopped at depth {max_depth}: {}", entry.path().display()));
                }
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    Nesting::Clean
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReapCandidate {
    pub path: String,
    pub size_bytes: u64,
    pub size_truncated: bool,
    /// `registered` · `orphaned` · `repo-unreachable` · `stranded` · `in-use` · `foreign` ·
    /// `malformed` · `protected`
    pub state: String,
    /// `keep` · `reap` · `needs-confirmation` · `refuse`.
    ///
    /// `needs-confirmation` is a QUARANTINE, not a soft reap: no sweep may act on it, and only an
    /// explicit user decision resolves it. It exists because the evidence that would settle the
    /// question is not on the machine — see `RepoAbsence`.
    pub verdict: String,
    /// The rule that decided it.
    pub rule: String,
    /// What the bidirectional proof found, pass or fail.
    pub proof: String,
    pub has_provenance: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_repo: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReapPlan {
    pub dry_run: bool,
    pub root: String,
    pub scanned: usize,
    pub reapable: usize,
    pub reapable_bytes: u64,
    /// Quarantined: surfaced to the user, never acted on by anything automatic.
    pub needs_confirmation: usize,
    pub needs_confirmation_bytes: u64,
    pub candidates: Vec<ReapCandidate>,
    /// One line per candidate — path, size, rule, proof — for the log and the report.
    pub lines: Vec<String>,
}

fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{n} B") } else { format!("{v:.1} {}", UNITS[i]) }
}

fn classify(path: &Path, store: &Path, sessions: &SessionIndex) -> ReapCandidate {
    let path_s = path.to_string_lossy().to_string();
    let prov = provenance_for(store, &path_s);
    let repo = prov.as_ref().map(|p| p.source_repo.clone()).or_else(|| repo_hint_from_marker(&path_s));
    let (size_bytes, size_truncated) = dir_size(path);

    let mut c = ReapCandidate {
        path: path_s.clone(),
        size_bytes,
        size_truncated,
        state: "unknown".into(),
        verdict: "refuse".into(),
        rule: String::new(),
        proof: String::new(),
        has_provenance: prov.is_some(),
        source_repo: repo.clone(),
    };

    // Guard rails first — they outrank every proof and every provenance record.
    if let Some(reason) = dangerous_removal_reason(&path_s, repo.as_deref()) {
        c.state = "protected".into();
        c.rule = format!("guard rail: {reason}");
        c.proof = "not attempted — guard rail refused first".into();
        return c;
    }

    // Then: is anybody working in there? Cheap, already on disk, and an absolute veto — no proof
    // of ownership makes a directory somebody is mid-turn in safe to delete.
    if let Some(why) = &sessions.unknown {
        c.state = "in-use".into();
        c.rule = format!("refuse: cannot tell whether a session is working here — {why}");
        c.proof = "not attempted — the session registry could not be read".into();
        return c;
    }
    if let Some(cwd) = sessions.claim_on(&path_s) {
        c.state = "in-use".into();
        c.rule = format!("refuse: a saved session records {cwd} as its working directory");
        c.proof = "not attempted — the directory is claimed".into();
        return c;
    }

    let proof = match repo.as_deref() {
        Some(repo) => prove_gitdir(&path_s, repo),
        None => match std::fs::symlink_metadata(path.join(".git")) {
            Err(ref e) if is_missing(e) => GitdirProof::NoMarker,
            _ => GitdirProof::Malformed("a .git exists but names no resolvable repository".into()),
        },
    };

    match proof {
        GitdirProof::Registered => {
            c.state = "registered".into();
            c.verdict = "keep".into();
            c.rule = "still registered with git — out of scope for phase 1".into();
            c.proof = "PASS all three: .git file → admin entry → back-reference".into();
            return c;
        }
        GitdirProof::Orphan => {
            c.state = "orphaned".into();
            c.proof = "PASS orphan: the repo resolved its own admin directory and holds no entry for this path — git pruned it".into();
        }
        GitdirProof::RepoUnreachable { ref repo, ref why } => {
            // R1/R2/R3: this is the branch that used to authorise every delete in the plan, on
            // the strength of a path not being there when we looked. It is now quarantined.
            c.state = "repo-unreachable".into();
            match why {
                RepoAbsence::Absent => {
                    c.verdict = "needs-confirmation".into();
                    c.rule = format!(
                        "needs confirmation: {repo} is not there — but a MOVED repo looks identical from here, \
                         keeps a live back-reference, and `git worktree repair` fixes it in one command"
                    );
                    c.proof = "UNPROVEN: the repo cannot corroborate anything, and every remaining link \
                               would be read out of this directory itself"
                        .into();
                }
                RepoAbsence::Unknown(e) => {
                    c.rule = format!("refuse: cannot tell whether {repo} exists — {e}");
                    c.proof = "UNPROVEN: could not look at the repo, which is not the same as it being gone".into();
                }
            }
            return c;
        }
        GitdirProof::Foreign { ref admin, ref points_at } => {
            c.state = "foreign".into();
            c.rule = "refuse: the admin entry belongs to another directory (copied .git file)".into();
            c.proof = format!("FAIL back-reference: {admin}/gitdir → {points_at}");
            return c;
        }
        GitdirProof::Malformed(ref why) => {
            c.state = "malformed".into();
            c.rule = format!("refuse: {why}");
            c.proof = format!("FAIL: {why}");
            return c;
        }
        GitdirProof::NoMarker => {
            c.state = "stranded".into();
            c.proof = "NOT RUN: no .git — nothing to prove ownership with".into();
            if prov.is_none() {
                c.rule = "refuse: stranded and no creation provenance — path shape is not authority".into();
                return c;
            }
        }
    }

    // Nesting is checked last because it is the expensive one, and only for a directory that has
    // already earned a reap.
    //
    // ONLY the on-disk walk here, not `nested_registered_worktree`. The walk is a strict superset
    // for this question — every nested worktree leaves a `.git` marker the walk now finds — and
    // asking git adds nothing except a second way to fail: a candidate's recorded source repo is
    // routinely the one that is gone, so `git worktree list` would answer `Unknown` and refuse
    // every reap in the plan for a reason that says nothing about nesting. `remove_worktree` keeps
    // that check because there git is about to be invoked in that repo anyway.
    match nested_checkout(path) {
        Nesting::Clean => {}
        Nesting::Nested(what) => {
            c.rule = format!("refuse: contains another checkout ({what})");
            return c;
        }
        Nesting::Unknown(why) => {
            c.rule = format!("refuse: cannot rule out a nested checkout — {why}");
            return c;
        }
    }

    c.verdict = "reap".into();
    c.rule = if c.state == "orphaned" {
        "reap: the owning repo answered and no longer holds an entry for this path".into()
    } else {
        "reap: stranded, but provenance records that Operator created it".into()
    };
    c
}

fn reap_plan_in(root: &Path, store: &Path, sessions_path: &Path, mode: ReapMode) -> ReapPlan {
    let sessions = load_sessions(sessions_path);
    let mut candidates: Vec<ReapCandidate> = vec![];
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                // Dot-entries are skipped wholesale, which is also what keeps the sweep and the
                // reaper from ever looking at each other's trash root.
                !name.starts_with('.') && e.file_type().map(|t| t.is_dir()).unwrap_or(false)
            })
            .map(|e| e.path())
            .collect();
        paths.sort();
        for p in paths {
            candidates.push(classify(&p, store, &sessions));
        }
    }

    let lines = candidates
        .iter()
        .map(|c| {
            let size = format!("{}{}", human_bytes(c.size_bytes), if c.size_truncated { "+" } else { "" });
            format!(
                "[{}] {} ({}) state={} rule={} proof={}",
                c.verdict.to_uppercase(),
                c.path,
                size,
                c.state,
                c.rule,
                c.proof
            )
        })
        .collect();

    let tally = |verdict: &str| -> (usize, u64) {
        let it = candidates.iter().filter(|c| c.verdict == verdict);
        (it.clone().count(), it.map(|c| c.size_bytes).sum())
    };
    let (reapable, reapable_bytes) = tally("reap");
    let (needs_confirmation, needs_confirmation_bytes) = tally("needs-confirmation");
    ReapPlan {
        dry_run: mode == ReapMode::DryRun,
        root: root.to_string_lossy().to_string(),
        scanned: candidates.len(),
        reapable,
        reapable_bytes,
        needs_confirmation,
        needs_confirmation_bytes,
        candidates,
        lines,
    }
}

/// THE DELIVERABLE OF PHASE 1: what a reaper WOULD do to `~/.operator/worktrees`, and nothing else.
/// There is no execute path wired to this — deciding when a healthy worktree retires is a policy
/// question that is not settled, and 21GB of the user's work is what a wrong answer costs.
pub fn reap_dry_run() -> ReapPlan {
    reap_plan_in(&worktree_root(), &provenance_file(), &sessions_file(), ReapMode::DryRun)
}

pub fn remove_worktree(path: &str, source_root: &str) -> Result<(), String> {
    if let Some(reason) = dangerous_removal_reason(path, Some(source_root)) {
        return Err(format!("Refusing to remove worktree {path}: {reason}"));
    }
    // THE PATH THAT DELETES FILES TODAY GETS THE STRONGER CHECK, not the weaker one. This used to
    // ask `git worktree list` and nothing else, so a lane that had checked out a different project
    // inside its own directory was invisible, and git failing to answer at all read as "nothing is
    // nested" and went straight on to `--force`. Both scans now run and both refuse when they
    // cannot answer — an operation the user can retry beats files that are already gone.
    for scan in [nested_registered_worktree(path, source_root), nested_checkout(Path::new(path))] {
        match scan {
            Nesting::Clean => {}
            Nesting::Nested(what) => {
                return Err(format!("Refusing to remove worktree {path}: it contains {what}"))
            }
            Nesting::Unknown(why) => {
                return Err(format!(
                    "Refusing to remove worktree {path}: cannot rule out a nested checkout — {why}"
                ))
            }
        }
    }
    if git(source_root, &["worktree", "remove", path]).is_err() {
        git(source_root, &["worktree", "remove", "--force", path])?;
    }
    Ok(())
}

pub fn commit_all(path: &str, message: &str) -> Result<String, String> {
    git(path, &["add", "-A"])?;
    let status = git(path, &["status", "--porcelain"]).unwrap_or_default();
    if status.is_empty() {
        return git(path, &["rev-parse", "HEAD"]);
    }
    git(path, &["commit", "-m", message])?;
    git(path, &["rev-parse", "HEAD"])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn merge_branch(worktree_path: &str, source_root: &str, branch: &str, base_branch: &str) -> MergeResult {
    match git(source_root, &["status", "--porcelain"]) {
        Ok(dirty) if !dirty.is_empty() => {
            return MergeResult { ok: false, message: Some("Source repo has uncommitted changes — commit or stash before merging.".into()) }
        }
        Err(e) => return MergeResult { ok: false, message: Some(e) },
        _ => {}
    }
    if let Ok(current) = git(source_root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        if current != base_branch {
            if let Err(e) = git(source_root, &["checkout", base_branch]) {
                return MergeResult { ok: false, message: Some(format!("Could not switch to {base_branch}: {e}")) };
            }
        }
    }
    if let Err(e) = git(source_root, &["merge", "--no-ff", "-m", &format!("Merge {branch}"), branch]) {
        let _ = git(source_root, &["merge", "--abort"]);
        return MergeResult { ok: false, message: Some(format!("Merge failed: {e}")) };
    }
    let _ = remove_worktree(worktree_path, source_root);
    MergeResult { ok: true, message: None }
}

pub fn discard_branch(worktree_path: &str, source_root: &str, branch: &str) -> Result<(), String> {
    let _ = remove_worktree(worktree_path, source_root);
    let _ = git(source_root, &["branch", "-D", branch]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hermetic scratch repo: init on `main` with an identity, one seed commit.
    fn scratch_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        git(p, &["init", "-b", "main"]).unwrap();
        git(p, &["config", "user.email", "t@t"]).unwrap();
        git(p, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        git(p, &["add", "-A"]).unwrap();
        git(p, &["commit", "-m", "seed"]).unwrap();
        dir
    }

    /// Paths that deliberately do not exist. A missing provenance store holds no records, and a
    /// missing session registry really does mean no sessions — both are legitimate states, and
    /// both are distinct from a store that could not be read.
    fn no_store() -> PathBuf {
        std::env::temp_dir().join("operator-test-absent-provenance.json")
    }
    fn no_sessions() -> PathBuf {
        std::env::temp_dir().join("operator-test-absent-sessions.json")
    }

    /// Root ignores directory permissions, so the EPERM fixtures cannot be built there. Probe for
    /// the behaviour rather than guessing at a uid — the question is only whether `chmod 000`
    /// actually denies us.
    fn permissions_are_enforced(dir: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        let probe = dir.join("perm-probe");
        if std::fs::create_dir_all(&probe).is_err() {
            return false;
        }
        let _ = std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o000));
        let denied = std::fs::read_dir(&probe).is_err();
        let _ = std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&probe);
        denied
    }

    // A repo with a REMOTE, so `origin/HEAD` exists and the name can be derived rather than
    // guessed. `clone` is the honest way to get one: faking refs by hand would test our fake.
    fn scratch_clone(origin: &tempfile::TempDir) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("clone");
        let dst_s = dst.to_str().unwrap();
        git(".", &["clone", origin.path().to_str().unwrap(), dst_s]).unwrap();
        git(dst_s, &["config", "user.email", "t@t"]).unwrap();
        git(dst_s, &["config", "user.name", "t"]).unwrap();
        dir
    }

    #[test]
    fn default_base_prefers_the_repos_own_default_over_the_callers_head() {
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        // No remote at all: the conventional names are the fallback, and `main` exists here.
        assert_eq!(default_base(p).as_deref(), Some("main"));

        // …and it does NOT follow the caller onto a side branch. This is the whole defect: a
        // coordinator sitting on a stale branch used to hand that branch to every lane.
        git(p, &["checkout", "-b", "operator/stale"]).unwrap();
        assert_eq!(default_base(p).as_deref(), Some("main"));
    }

    #[test]
    fn default_base_derives_the_name_from_origin_head_rather_than_assuming_main() {
        // A repo whose default branch is called neither `main` nor `master`. Hardcoding either
        // would resolve to nothing here and silently fall back to HEAD.
        let origin = tempfile::tempdir().unwrap();
        let o = origin.path().to_str().unwrap();
        git(o, &["init", "-b", "trunk"]).unwrap();
        git(o, &["config", "user.email", "t@t"]).unwrap();
        git(o, &["config", "user.name", "t"]).unwrap();
        std::fs::write(origin.path().join("a.txt"), "one\n").unwrap();
        git(o, &["add", "-A"]).unwrap();
        git(o, &["commit", "-m", "seed"]).unwrap();

        let clone = scratch_clone(&origin);
        let c = clone.path().join("clone");
        let cs = c.to_str().unwrap();
        assert_eq!(default_base(cs).as_deref(), Some("trunk"));
    }

    #[test]
    fn default_base_takes_the_LOCAL_branch_so_merged_but_unpushed_work_is_not_dropped() {
        // This project merges lane branches into local `main` and pushes later, so `origin/main`
        // is routinely behind by exactly the work just merged. Forking from the remote ref would
        // lose it — the same class of defect, pointing the other way.
        let origin = tempfile::tempdir().unwrap();
        let o = origin.path().to_str().unwrap();
        git(o, &["init", "-b", "main"]).unwrap();
        git(o, &["config", "user.email", "t@t"]).unwrap();
        git(o, &["config", "user.name", "t"]).unwrap();
        std::fs::write(origin.path().join("a.txt"), "one\n").unwrap();
        git(o, &["add", "-A"]).unwrap();
        git(o, &["commit", "-m", "seed"]).unwrap();

        let clone = scratch_clone(&origin);
        let c = clone.path().join("clone");
        let cs = c.to_str().unwrap();
        // A local commit on main that the remote has never seen.
        std::fs::write(c.join("a.txt"), "one\nlocal\n").unwrap();
        git(cs, &["add", "-A"]).unwrap();
        git(cs, &["commit", "-m", "merged locally, not pushed"]).unwrap();

        assert_eq!(default_base(cs).as_deref(), Some("main"));
        let local = git(cs, &["rev-parse", "main"]).unwrap();
        let remote = git(cs, &["rev-parse", "origin/main"]).unwrap();
        assert_ne!(local, remote, "fixture must actually be ahead, or this proves nothing");
        // The base resolves to the LOCAL ref, not the remote-tracking one.
        assert_eq!(git(cs, &["rev-parse", &default_base(cs).unwrap()]).unwrap(), local);
    }

    #[test]
    fn a_new_lane_is_zero_commits_behind_the_default_branch() {
        // THE ACCEPTANCE TEST for part 2, phrased as the brief phrases it. Launch from a stale
        // side branch and the lane must still start level with `main`.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        // main moves on…
        std::fs::write(repo.path().join("a.txt"), "one\ntwo\n").unwrap();
        git(p, &["add", "-A"]).unwrap();
        git(p, &["commit", "-m", "main moves on"]).unwrap();
        // …while the caller sits on a branch cut before that commit.
        git(p, &["checkout", "-b", "operator/stale", "HEAD~1"]).unwrap();

        let made = create_worktree(p, None, None).expect("worktree created");
        let wt = made.path.clone();
        // 0 commits in `main` that the lane's branch does not have.
        let behind = git(&wt, &["rev-list", "--count", &format!("{}..main", made.branch)]).unwrap();
        assert_eq!(behind, "0", "a fresh lane must not start behind the default branch");
        // It reports what it forked FROM, not what the caller was on.
        assert_eq!(made.base_branch.as_deref(), Some("main"));

        git(p, &["worktree", "remove", "--force", &wt]).ok();
    }

    #[test]
    fn create_worktree_still_starts_a_lane_when_no_default_branch_resolves() {
        // Detached HEAD with no `main`/`master` and no remote: nothing to resolve, so it must fall
        // back to the old `HEAD` behaviour rather than failing the launch.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        git(p, &["checkout", "-b", "only-branch"]).unwrap();
        git(p, &["branch", "-D", "main"]).unwrap();
        assert_eq!(default_base(p), None);

        let made = create_worktree(p, None, None).expect("a lane still starts");
        assert_eq!(made.base_branch.as_deref(), Some("HEAD"));
        git(p, &["worktree", "remove", "--force", &made.path]).ok();
    }

    #[test]
    fn a_suspended_lane_comes_back_on_its_own_branch_with_its_own_work() {
        // THE RESUME HALF of task-scoped lanes: close removes the directory and keeps the branch,
        // so relaunching has to reattach to that branch — otherwise the resumed conversation gets
        // a tree with none of the work it remembers doing.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();

        let made = create_worktree(p, None, None).expect("lane created");
        std::fs::write(format!("{}/lane.txt", made.path), "lane work\n").unwrap();
        git(&made.path, &["add", "-A"]).unwrap();
        git(&made.path, &["commit", "-m", "lane work"]).unwrap();
        // Close: directory gone, branch kept.
        remove_worktree(&made.path, p).unwrap();
        assert!(!std::path::Path::new(&made.path).exists());

        let back = create_worktree(p, Some(&made.branch), None).expect("lane resumed");
        assert_eq!(back.branch, made.branch, "must reattach, not fork a new branch");
        assert_eq!(back.path, made.path, "and come back where it was");
        assert_eq!(
            std::fs::read_to_string(format!("{}/lane.txt", back.path)).unwrap(),
            "lane work\n",
            "its committed work has to be in the tree it resumes into",
        );

        git(p, &["worktree", "remove", "--force", &back.path]).ok();
    }

    #[test]
    fn an_unreattachable_branch_still_starts_a_lane() {
        // The branch is checked out in a worktree that is still live, or never existed. Falling
        // back to a fresh branch is right: a lane that starts beats a launch that fails.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();

        let held = create_worktree(p, None, None).expect("lane created"); // still checked out
        let fresh = create_worktree(p, Some(&held.branch), None).expect("a lane still starts");
        assert_ne!(fresh.branch, held.branch);

        let unknown = create_worktree(p, Some("operator/never-existed"), None).expect("a lane still starts");
        assert_ne!(unknown.branch, "operator/never-existed");

        for w in [&held.path, &fresh.path, &unknown.path] {
            git(p, &["worktree", "remove", "--force", w]).ok();
        }
    }

    #[test]
    fn branch_diff_survives_worktree_removal_semantics() {
        // The task-diff fallback: a lane's branch, diffed vs its base from the source root.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        git(p, &["checkout", "-b", "operator/x"]).unwrap();
        std::fs::write(repo.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.path().join("b.txt"), "new\n").unwrap();
        git(p, &["add", "-A"]).unwrap();
        git(p, &["commit", "-m", "lane work"]).unwrap();
        git(p, &["checkout", "main"]).unwrap();

        let d = branch_diff(p, "operator/x", "main");
        assert_eq!(d.files.len(), 2);
        let b = d.files.iter().find(|f| f.path == "b.txt").expect("b.txt listed");
        assert_eq!((b.added, b.removed), (1, 0));
        assert!(d.diff.contains("+two"));

        // Unknown branch → empty, not a panic.
        let none = branch_diff(p, "operator/gone", "main");
        assert!(none.files.is_empty() && none.diff.is_empty());
    }

    // --- Reaper: guard rails ---------------------------------------------------

    #[test]
    fn guard_rails_refuse_every_path_that_would_take_more_than_a_worktree() {
        let repo = "/Users/x/dev/project";
        // Each of these is a distinct way to lose the user's work, and each is a rule.
        for (path, why) in [
            ("", "empty"),
            ("   ", "whitespace only"),
            ("/Users/x/dev/project", "the repo itself"),
            ("/", "the filesystem root"),
            ("/Users/x/dev", "contains the repo"),
            ("/home", "the posix home root"),
            ("/root", "root's home"),
            ("/home/someone", "a user home"),
            ("/Users/someone", "a macOS user home"),
        ] {
            assert!(
                dangerous_removal_reason(path, Some(repo)).is_some(),
                "must refuse {path} ({why})",
            );
        }
        // …and an ordinary sibling worktree is allowed through.
        assert_eq!(dangerous_removal_reason("/Users/x/.operator/worktrees/project-ab12", Some(repo)), None);
    }

    #[test]
    fn guard_rails_refuse_anything_that_contains_home() {
        let home = std::env::var("HOME").unwrap_or_default();
        assert!(!home.is_empty(), "the fixture needs a HOME");
        assert!(dangerous_removal_reason(&home, None).is_some());
        let parent = Path::new(&home).parent().unwrap().to_string_lossy().to_string();
        assert!(dangerous_removal_reason(&parent, None).is_some(), "a parent of $HOME takes $HOME with it");
    }

    #[test]
    fn path_containment_separates_dotdot_from_a_directory_merely_named_dotdot_something() {
        // `..` escapes the parent; `..name` is an ordinary child whose name starts with two dots.
        // A string-prefix test gets both wrong, in opposite directions.
        assert!(contains_path("/a/b", "/a/b/..name"));
        assert!(!contains_path("/a/b", "/a/b/.."));
        assert!(!contains_path("/a/b", "/a/b/../c"));
        assert!(contains_path("/a/b", "/a/b/..name/deeper"));
        // And a sibling whose name merely starts with the same characters is not inside.
        assert!(!contains_path("/a/b", "/a/bc"));
        assert!(contains_path("/a/b", "/a/b"));
    }

    #[test]
    fn removal_refuses_a_worktree_that_contains_another_registered_worktree() {
        // `git worktree remove --force` would delete the nested worktree's files as ordinary
        // untracked content and leave git a prunable record — silent data loss both ways.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let outer = repo.path().parent().unwrap().join(format!("outer-{}", short_id()));
        let outer_s = outer.to_str().unwrap();
        git(p, &["worktree", "add", "-b", "operator/outer", outer_s, "main"]).unwrap();
        let inner = outer.join("nested");
        git(p, &["worktree", "add", "-b", "operator/inner", inner.to_str().unwrap(), "main"]).unwrap();

        assert!(matches!(nested_registered_worktree(outer_s, p), Nesting::Nested(_)), "the fixture must actually nest");
        let err = remove_worktree(outer_s, p).expect_err("must refuse");
        assert!(err.contains("contains"), "{err}");
        // The nested worktree's files are still there — that is the whole point.
        assert!(inner.join(".git").exists());

        git(p, &["worktree", "remove", "--force", inner.to_str().unwrap()]).ok();
        git(p, &["worktree", "remove", "--force", outer_s]).ok();
    }

    // --- Reaper: the bidirectional gitdir proof ---------------------------------

    #[test]
    fn a_live_worktree_proves_registered_and_an_unlinked_one_proves_orphan() {
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let wt = repo.path().parent().unwrap().join(format!("wt-{}", short_id()));
        let wt_s = wt.to_str().unwrap();
        git(p, &["worktree", "add", "-b", "operator/proof", wt_s, "main"]).unwrap();

        assert_eq!(prove_gitdir(wt_s, p), GitdirProof::Registered);

        // Now make it what the 4 reapable directories are: the admin entry pruned away, the
        // directory and its `.git` file left behind.
        let admin = repo.path().join(".git").join("worktrees").join(wt.file_name().unwrap());
        std::fs::remove_dir_all(&admin).unwrap();
        assert_eq!(prove_gitdir(wt_s, p), GitdirProof::Orphan);

        std::fs::remove_dir_all(&wt).ok();
    }

    #[test]
    fn an_absent_repo_is_quarantined_and_never_reaped() {
        // R2/R3. Phase 1 called this `Orphan { repo_missing: true }` and reaped it. It is not a
        // proof of anything: with the repo unreachable, all three "independent" links reduce to
        // content read out of the candidate itself.
        let repo = scratch_repo();
        let repo_path = repo.path().to_path_buf();
        let wt = repo_path.parent().unwrap().join(format!("gone-{}", short_id()));
        let wt_s = wt.to_str().unwrap().to_string();
        git(repo_path.to_str().unwrap(), &["worktree", "add", "-b", "operator/gone", &wt_s, "main"]).unwrap();

        let repo_s = repo_path.to_string_lossy().to_string();
        drop(repo); // the whole repository goes away, the worktree directory stays

        assert!(!Path::new(&repo_s).exists(), "the fixture must actually delete the repo");
        assert_eq!(
            prove_gitdir(&wt_s, &repo_s),
            GitdirProof::RepoUnreachable { repo: repo_s.clone(), why: RepoAbsence::Absent },
        );
        // The repo hint is still read out of the surviving `.git` file — it is what the candidate
        // CLAIMS, which is exactly why it cannot also be the corroboration.
        assert!(same_path(&repo_hint_from_marker(&wt_s).expect("repo named by .git"), &repo_s));

        let c = classify(&wt, &no_store(), &load_sessions(&no_sessions()));
        assert_eq!(c.verdict, "needs-confirmation", "quarantine, never an automatic delete");
        assert_eq!(c.state, "repo-unreachable");
        assert!(c.proof.starts_with("UNPROVEN"), "{}", c.proof);

        std::fs::remove_dir_all(&wt).ok();
    }

    #[test]
    fn a_moved_repo_is_never_reaped_because_git_can_repair_it_in_one_command() {
        // R2, the review's fixture end to end. After a rename the candidate's `.git` still names
        // the dead path — byte-identical to a deletion from here — but the BACK-REFERENCE at the
        // new location survives, git still lists the worktree as live, and `git worktree repair`
        // fixes it. The worktree's uncommitted work is the only copy, and phase 1 reaped it.
        let home = tempfile::tempdir().unwrap();
        let repo_dir = home.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let r = repo_dir.to_str().unwrap();
        git(r, &["init", "-b", "main"]).unwrap();
        git(r, &["config", "user.email", "t@t"]).unwrap();
        git(r, &["config", "user.name", "t"]).unwrap();
        std::fs::write(repo_dir.join("a.txt"), "one\n").unwrap();
        git(r, &["add", "-A"]).unwrap();
        git(r, &["commit", "-m", "seed"]).unwrap();

        let root = home.path().join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let wt = root.join("lane");
        git(r, &["worktree", "add", "-b", "lane", wt.to_str().unwrap()]).unwrap();
        std::fs::write(wt.join("only-copy.txt"), "uncommitted work\n").unwrap();

        let moved = home.path().join("repo-moved");
        std::fs::rename(&repo_dir, &moved).unwrap();

        // The state the review described, asserted rather than assumed.
        assert!(!repo_dir.exists(), "the old path is gone");
        let back = std::fs::read_to_string(moved.join(".git/worktrees/lane/gitdir")).unwrap();
        assert!(same_path(back.trim(), &wt.join(".git").to_string_lossy()), "back-reference survives the move");
        let listed = git(moved.to_str().unwrap(), &["worktree", "list", "--porcelain"]).unwrap();
        assert!(listed.contains(&wt.to_string_lossy().to_string()), "git still calls this worktree live");

        let plan = reap_plan_in(&root, &no_store(), &no_sessions(), ReapMode::DryRun);
        let c = plan.candidates.iter().find(|c| c.path.ends_with("lane")).unwrap();
        assert_ne!(c.verdict, "reap", "a repairable worktree must never be reaped");
        assert_eq!(c.verdict, "needs-confirmation");
        assert_eq!(plan.reapable, 0);
        assert_eq!(plan.needs_confirmation, 1);
        assert!(wt.join("only-copy.txt").exists());

        // And it really is one command away from working again.
        git(moved.to_str().unwrap(), &["worktree", "repair", wt.to_str().unwrap()]).unwrap();
        assert_eq!(prove_gitdir(&wt.to_string_lossy(), &moved.to_string_lossy()), GitdirProof::Registered);
    }

    #[test]
    fn a_repo_we_are_not_allowed_to_look_at_is_refused_outright() {
        // R1. `Path::exists()` is false for EVERY error, so an unreadable parent — a sandbox, a
        // TCC-protected folder, an unmounted volume at boot — used to read as "the repo is gone"
        // and authorised a delete. Only a clean NotFound may mean absent.
        let repo = scratch_repo();
        if !permissions_are_enforced(repo.path()) {
            eprintln!("skipped: directory permissions are not enforced here (root?)");
            return;
        }
        let repo_path = repo.path().to_path_buf();
        let wt = repo_path.parent().unwrap().join(format!("locked-{}", short_id()));
        let wt_s = wt.to_str().unwrap().to_string();
        git(repo_path.to_str().unwrap(), &["worktree", "add", "-b", "operator/locked", &wt_s, "main"]).unwrap();

        // Make the repo's PARENT untraversable — the repository itself is untouched and alive.
        let parent = repo_path.parent().unwrap().to_path_buf();
        let locked = parent.join(format!("locked-parent-{}", short_id()));
        std::fs::create_dir_all(&locked).unwrap();
        let hidden_repo = locked.join("repo");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let hidden = hidden_repo.to_string_lossy().to_string();
        assert!(!Path::new(&hidden).exists(), "exists() lies here — that is the whole finding");
        match repo_presence(&hidden) {
            RepoPresence::Unknown(_) => {}
            other => panic!("an unreadable parent must be Unknown, got {other:?}"),
        }
        match prove_gitdir(&wt_s, &hidden) {
            GitdirProof::RepoUnreachable { why: RepoAbsence::Unknown(_), .. } => {}
            other => panic!("must not conclude absence, got {other:?}"),
        }

        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&locked).ok();
        std::fs::remove_dir_all(&wt).ok();
    }

    #[test]
    fn a_candidate_a_session_is_working_in_is_refused() {
        // R4. The session registry sits beside the provenance store and nothing was reading it;
        // Operator hit this by hand, with 3 of 15 candidates turning out to be live lanes.
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join("sessions.json");
        let store = home.path().join("provenance.json");

        let busy = root.path().join("project-busy");
        let idle = root.path().join("project-idle");
        for d in [&busy, &idle] {
            std::fs::create_dir_all(d).unwrap();
            record_provenance_in(&store, Provenance {
                path: d.to_string_lossy().to_string(),
                created_at: 1,
                created_by: "operator".into(),
                source_repo: "/dev/project".into(),
                branch: "operator/x".into(),
                lane_id: None,
            });
        }
        std::fs::write(
            &sessions,
            format!(r#"[{{"key":"k","cwd":{:?},"roleId":"research"}}]"#, busy.to_string_lossy()),
        )
        .unwrap();

        let plan = reap_plan_in(root.path(), &store, &sessions, ReapMode::DryRun);
        let busy_c = plan.candidates.iter().find(|c| c.path.ends_with("busy")).unwrap();
        let idle_c = plan.candidates.iter().find(|c| c.path.ends_with("idle")).unwrap();
        assert_eq!(busy_c.verdict, "refuse");
        assert_eq!(busy_c.state, "in-use");
        assert_eq!(idle_c.verdict, "reap", "the control must still reap, or this proves nothing");

        // A registry that cannot be read is not an empty registry.
        std::fs::write(&sessions, "{ not json").unwrap();
        let plan = reap_plan_in(root.path(), &store, &sessions, ReapMode::DryRun);
        assert_eq!(plan.reapable, 0, "an unreadable session registry refuses everything");
        assert!(plan.candidates.iter().all(|c| c.rule.contains("cannot tell whether a session")));
    }

    #[test]
    fn a_nested_plain_clone_is_detected_not_only_a_nested_worktree() {
        // R7. A nested worktree loses uncommitted work; a nested CLONE loses unpushed commits,
        // because its object store is the only copy. The `.git` DIRECTORY was the unchecked case.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let cand = repo.path().parent().unwrap().join(format!("cand-{}", short_id()));
        std::fs::create_dir_all(cand.join("deep").join("deeper")).unwrap();
        assert_eq!(nested_checkout(&cand), Nesting::Clean);

        git(".", &["clone", "-q", p, cand.join("deep").join("vendored").to_str().unwrap()]).unwrap();
        assert!(cand.join("deep/vendored/.git").is_dir(), "the fixture must be a clone, not a worktree");
        match nested_checkout(&cand) {
            Nesting::Nested(what) => assert!(what.contains("vendored") && what.contains("repository"), "{what}"),
            other => panic!("a nested clone must be found, got {other:?}"),
        }

        std::fs::remove_dir_all(&cand).ok();
    }

    #[test]
    fn remove_worktree_refuses_foreign_nesting_and_refuses_when_git_cannot_answer() {
        // R6, both halves. The live removal path had the WEAK check: `git worktree list` in the
        // source repo, which cannot see another project's checkout, and which returned an empty
        // list on failure that read as "nothing is nested" before going on to `--force`.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let other = scratch_repo(); // a DIFFERENT repository
        let wt = repo.path().parent().unwrap().join(format!("host-{}", short_id()));
        let wt_s = wt.to_str().unwrap().to_string();
        git(p, &["worktree", "add", "-b", "operator/host", &wt_s, "main"]).unwrap();

        // A worktree of the OTHER repo, checked out inside ours. Invisible to our `worktree list`.
        let foreign = wt.join("vendor").join("other");
        std::fs::create_dir_all(wt.join("vendor")).unwrap();
        git(other.path().to_str().unwrap(), &["worktree", "add", "-b", "x", foreign.to_str().unwrap()]).unwrap();
        assert_eq!(nested_registered_worktree(&wt_s, p), Nesting::Clean, "git genuinely cannot see it");

        let err = remove_worktree(&wt_s, p).expect_err("must refuse");
        assert!(err.contains("contains"), "{err}");
        assert!(foreign.join("a.txt").exists(), "the foreign checkout's files must survive");

        // …and a source repo git cannot answer for is a refusal, not a green light.
        let nowhere = repo.path().parent().unwrap().join("no-such-repo").to_string_lossy().to_string();
        match nested_registered_worktree(&wt_s, &nowhere) {
            Nesting::Unknown(_) => {}
            other => panic!("git failing must be Unknown, got {other:?}"),
        }
        let err = remove_worktree(&wt_s, &nowhere).expect_err("must refuse");
        assert!(err.contains("cannot rule out"), "{err}");

        git(other.path().to_str().unwrap(), &["worktree", "remove", "--force", foreign.to_str().unwrap()]).ok();
        git(p, &["worktree", "remove", "--force", &wt_s]).ok();
    }

    #[test]
    fn a_walk_that_ran_out_of_budget_or_depth_says_so_instead_of_clean() {
        // R8. `None` used to mean four things, three of which were "I did not look". Review
        // measured this project's built checkout at 122,494 entries against a 20,000 cap — one
        // `cargo build` in a lane silently switched the nesting refusal off.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("cand");
        let mut deep = root.clone();
        for seg in ["a", "b", "c"] {
            deep = deep.join(seg);
        }
        std::fs::create_dir_all(&deep).unwrap();
        for i in 0..12 {
            std::fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }

        // Bounds honoured: the walk completes and says so.
        assert_eq!(nested_checkout_within(&root, 10_000, 32), Nesting::Clean);

        // Out of entries — NOT clean.
        match nested_checkout_within(&root, 4, 32) {
            Nesting::Unknown(why) => assert!(why.contains("gave up after 4 entries"), "{why}"),
            other => panic!("exceeding the entry cap must be Unknown, got {other:?}"),
        }
        // Out of depth — NOT clean, even though nothing was found in what it did see.
        match nested_checkout_within(&root, 10_000, 2) {
            Nesting::Unknown(why) => assert!(why.contains("stopped at depth 2"), "{why}"),
            other => panic!("exceeding the depth cap must be Unknown, got {other:?}"),
        }

        // And an `Unknown` walk refuses the candidate rather than reaping it — through the real
        // caps this time, with a subdirectory the walk is not allowed to open. Without provenance
        // this directory would be refused for being stranded, so the record is what makes the
        // nesting rule the thing under test.
        if permissions_are_enforced(dir.path()) {
            use std::os::unix::fs::PermissionsExt;
            let store = dir.path().join("provenance.json");
            record_provenance_in(&store, Provenance {
                path: root.to_string_lossy().to_string(),
                created_at: 1,
                created_by: "operator".into(),
                source_repo: "/dev/project".into(),
                branch: "operator/x".into(),
                lane_id: None,
            });
            let shut = root.join("a");
            std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
            let plan = reap_plan_in(dir.path(), &store, &no_sessions(), ReapMode::DryRun);
            let c = plan.candidates.iter().find(|c| c.path.ends_with("cand")).unwrap();
            assert_eq!(c.verdict, "refuse");
            assert!(c.rule.contains("cannot rule out a nested checkout"), "{}", c.rule);
            std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn a_copied_git_file_is_refused_because_the_back_reference_points_elsewhere() {
        // THE CASE THE THIRD STEP EXISTS FOR. Steps 1 and 2 pass perfectly: the `.git` file is
        // well-formed and names a direct child of `<repo>/.git/worktrees`. Only the admin entry's
        // back-reference says it belongs to somebody else.
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let real = repo.path().parent().unwrap().join(format!("real-{}", short_id()));
        git(p, &["worktree", "add", "-b", "operator/real", real.to_str().unwrap(), "main"]).unwrap();

        let impostor = repo.path().parent().unwrap().join(format!("impostor-{}", short_id()));
        std::fs::create_dir_all(&impostor).unwrap();
        std::fs::copy(real.join(".git"), impostor.join(".git")).unwrap();

        match prove_gitdir(impostor.to_str().unwrap(), p) {
            GitdirProof::Foreign { .. } => {}
            other => panic!("a copied .git must not prove ownership, got {other:?}"),
        }

        std::fs::remove_dir_all(&impostor).ok();
        git(p, &["worktree", "remove", "--force", real.to_str().unwrap()]).ok();
    }

    #[test]
    fn a_directory_with_no_git_marker_proves_nothing_and_a_plain_repo_is_malformed() {
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();

        let bare = repo.path().parent().unwrap().join(format!("bare-{}", short_id()));
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(prove_gitdir(bare.to_str().unwrap(), p), GitdirProof::NoMarker);

        // A `.git` DIRECTORY is a repository of its own, never a worktree of ours.
        let own = repo.path().parent().unwrap().join(format!("own-{}", short_id()));
        std::fs::create_dir_all(own.join(".git")).unwrap();
        assert!(matches!(prove_gitdir(own.to_str().unwrap(), p), GitdirProof::Malformed(_)));

        // A gitdir pointing somewhere that is not a direct child of `<repo>/.git/worktrees`.
        let nested = repo.path().parent().unwrap().join(format!("nested-{}", short_id()));
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join(".git"),
            format!("gitdir: {}/.git/worktrees/a/b\n", repo.path().display()),
        )
        .unwrap();
        assert!(matches!(prove_gitdir(nested.to_str().unwrap(), p), GitdirProof::Malformed(_)));

        for d in [&bare, &own, &nested] {
            std::fs::remove_dir_all(d).ok();
        }
    }

    // --- Reaper: provenance ------------------------------------------------------

    #[test]
    fn provenance_survives_the_directory_and_is_the_only_evidence_for_a_stranded_one() {
        let home = tempfile::tempdir().unwrap();
        let store = home.path().join("worktree-provenance.json");
        record_provenance_in(&store, Provenance {
            path: "/w/project-ab12".into(),
            created_at: 1,
            created_by: "operator".into(),
            source_repo: "/dev/project".into(),
            branch: "operator/ab12".into(),
            lane_id: Some("code".into()),
        });
        assert_eq!(provenance_for(&store, "/w/project-ab12").unwrap().lane_id.as_deref(), Some("code"));
        assert!(provenance_for(&store, "/w/somebody-elses").is_none());

        // Re-recording the same path replaces rather than duplicates.
        record_provenance_in(&store, Provenance {
            path: "/w/project-ab12".into(),
            created_at: 2,
            created_by: "operator".into(),
            source_repo: "/dev/project".into(),
            branch: "operator/ab12".into(),
            lane_id: None,
        });
        assert_eq!(load_provenance_from(&store).len(), 1);
        assert_eq!(provenance_for(&store, "/w/project-ab12").unwrap().created_at, 2);
    }

    #[test]
    fn a_stranded_directory_is_reaped_only_when_provenance_says_we_made_it() {
        // The 3 measured stranded directories have no `.git`, so the proof cannot run on them.
        // Path shape is not authority — the user can keep their own worktrees in the same folder.
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let store = home.path().join("worktree-provenance.json");
        let ours = root.path().join("project-ours");
        let theirs = root.path().join("project-theirs");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(ours.join("file.txt"), "x").unwrap();

        record_provenance_in(&store, Provenance {
            path: ours.to_string_lossy().to_string(),
            created_at: 1,
            created_by: "operator".into(),
            source_repo: "/dev/project".into(),
            branch: "operator/ours".into(),
            lane_id: None,
        });

        let plan = reap_plan_in(root.path(), &store, &no_sessions(), ReapMode::DryRun);
        assert!(plan.dry_run);
        assert_eq!(plan.scanned, 2);
        let ours_c = plan.candidates.iter().find(|c| c.path.ends_with("project-ours")).unwrap();
        let theirs_c = plan.candidates.iter().find(|c| c.path.ends_with("project-theirs")).unwrap();
        assert_eq!(ours_c.verdict, "reap");
        assert_eq!(ours_c.state, "stranded");
        assert_eq!(theirs_c.verdict, "refuse");
        assert!(theirs_c.rule.contains("provenance"), "{}", theirs_c.rule);
        // A dry run deletes nothing, whatever it decided.
        assert!(ours.exists() && theirs.exists());
    }

    #[test]
    fn the_dry_run_keeps_a_registered_worktree_and_reaps_an_orphaned_one() {
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap().path().join("provenance.json");

        let live = root.path().join("live");
        let dead = root.path().join("dead");
        git(p, &["worktree", "add", "-b", "operator/live", live.to_str().unwrap(), "main"]).unwrap();
        git(p, &["worktree", "add", "-b", "operator/dead", dead.to_str().unwrap(), "main"]).unwrap();
        std::fs::remove_dir_all(repo.path().join(".git").join("worktrees").join("dead")).unwrap();

        let plan = reap_plan_in(root.path(), &store, &no_sessions(), ReapMode::DryRun);
        let live_c = plan.candidates.iter().find(|c| c.path.ends_with("live")).unwrap();
        let dead_c = plan.candidates.iter().find(|c| c.path.ends_with("dead")).unwrap();
        assert_eq!((live_c.state.as_str(), live_c.verdict.as_str()), ("registered", "keep"));
        assert_eq!((dead_c.state.as_str(), dead_c.verdict.as_str()), ("orphaned", "reap"));
        assert_eq!(plan.reapable, 1);
        assert!(live_c.proof.starts_with("PASS all three"), "{}", live_c.proof);
        // Both directories are still on disk: a dry run reports, it does not act.
        assert!(live.exists() && dead.exists());

        git(p, &["worktree", "remove", "--force", live.to_str().unwrap()]).ok();
    }

    #[test]
    fn an_orphan_holding_another_worktree_is_refused_even_though_its_own_proof_passed() {
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap().path().join("provenance.json");

        let outer = root.path().join("outer");
        git(p, &["worktree", "add", "-b", "operator/outer2", outer.to_str().unwrap(), "main"]).unwrap();
        let inner = outer.join("inner");
        git(p, &["worktree", "add", "-b", "operator/inner2", inner.to_str().unwrap(), "main"]).unwrap();
        // Orphan the OUTER one only: its own proof now passes, and deleting it would still take
        // the live inner worktree's files with it.
        std::fs::remove_dir_all(repo.path().join(".git").join("worktrees").join("outer")).unwrap();

        let plan = reap_plan_in(root.path(), &store, &no_sessions(), ReapMode::DryRun);
        let c = plan.candidates.iter().find(|c| c.path.ends_with("outer")).unwrap();
        assert_eq!(c.state, "orphaned");
        assert_eq!(c.verdict, "refuse");
        assert!(c.rule.contains("contains another checkout"), "{}", c.rule);
        assert!(c.proof.starts_with("PASS orphan"), "the proof passed; the nesting rule is what refused");

        git(p, &["worktree", "remove", "--force", inner.to_str().unwrap()]).ok();
        std::fs::remove_dir_all(&outer).ok();
    }

    // --- Reaper: deferred trash + sweep -------------------------------------------

    #[test]
    fn a_trash_rename_is_reversible_and_only_generated_names_are_ever_swept() {
        let parent = tempfile::tempdir().unwrap();
        let wt = parent.path().join("project-ab12");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("keep.txt"), "work").unwrap();

        // The dry run does not move anything.
        assert!(move_to_trash(&wt, ReapMode::DryRun).is_none());
        assert!(wt.join("keep.txt").exists());

        let trashed = move_to_trash(&wt, ReapMode::Execute).expect("renamed aside");
        assert!(!wt.exists());
        assert_eq!(trashed.parent().unwrap(), parent.path().join(TRASH_DIR_NAME));
        assert!(is_trash_entry_name(&trashed.file_name().unwrap().to_string_lossy()));

        // Restore puts it back byte for byte — block, don't orphan.
        assert!(restore_from_trash(&trashed, &wt));
        assert_eq!(std::fs::read_to_string(wt.join("keep.txt")).unwrap(), "work");

        // Sweep only ever removes entries it can prove it named.
        let trash_root = parent.path().join(TRASH_DIR_NAME);
        let mine = trash_root.join("wt-1754870000000-deadbeef");
        let theirs = trash_root.join("someone-elses-backup");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        assert_eq!(sweep_trash(&[trash_root.clone()], ReapMode::DryRun), 1, "dry run counts, deletes nothing");
        assert!(mine.exists());
        assert_eq!(sweep_trash(&[trash_root.clone()], ReapMode::Execute), 1);
        assert!(!mine.exists());
        assert!(theirs.exists(), "a directory we did not name is not ours to delete");
    }

    #[test]
    fn trash_entry_names_are_unique_and_recognised_exactly() {
        let a = trash_entry_name("/w/project-ab12");
        let b = trash_entry_name("/w/project-ab12");
        assert_ne!(a, b, "the nonce is what stops concurrent same-named removals colliding");
        assert!(is_trash_entry_name(&a) && is_trash_entry_name(&b));
        for bad in ["wt-", "wt-abc-deadbeef", "wt-123-DEADBEEF", "wt-123-dead", "project-ab12", "wt-123-deadbeeff"] {
            assert!(!is_trash_entry_name(bad), "{bad} must not look like ours");
        }
    }

    #[test]
    fn creating_a_lane_records_who_made_it() {
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        let made = create_worktree(p, None, Some("code")).expect("lane created");

        let rec = provenance_for(&provenance_file(), &made.path).expect("provenance recorded");
        assert_eq!(rec.created_by, "operator");
        assert_eq!(rec.lane_id.as_deref(), Some("code"));
        assert_eq!(rec.branch, made.branch);
        assert!(same_path(&rec.source_repo, p));
        assert!(rec.created_at > 0);

        git(p, &["worktree", "remove", "--force", &made.path]).ok();
    }

    /// The phase-1 deliverable, run against the REAL `~/.operator/worktrees`:
    /// `cargo test -- --ignored --nocapture dry_run_over_the_real_worktree_root`.
    /// Ignored by default because it walks tens of gigabytes and its output is a report, not an
    /// assertion. It deletes nothing — there is no execute path wired to `reap_dry_run`.
    /// What the nesting walk COSTS, now that `remove_worktree` pays it on every lane close:
    /// `cargo test -- --ignored --nocapture nesting_walk_cost_over_the_real_worktree_root`.
    /// Ignored for the same reason as the dry run — it is a measurement, not an assertion.
    #[test]
    #[ignore]
    fn nesting_walk_cost_over_the_real_worktree_root() {
        let mut rows: Vec<(u128, String, String)> = vec![];
        // `OPERATOR_NEST_PROBE=<dir>` points it somewhere else — a fully built checkout is the
        // interesting case and does not live under the worktree root.
        let root = std::env::var("OPERATOR_NEST_PROBE").map(PathBuf::from).unwrap_or_else(|_| worktree_root());
        let Ok(entries) = std::fs::read_dir(root) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let start = std::time::Instant::now();
            let verdict = nested_checkout(&e.path());
            rows.push((start.elapsed().as_millis(), name, format!("{verdict:?}")));
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        let total: u128 = rows.iter().map(|r| r.0).sum();
        println!("{} dirs, {total} ms total, slowest first:", rows.len());
        for (ms, name, verdict) in rows.iter().take(12) {
            println!("  {ms:>6} ms  {name}  {}", verdict.chars().take(90).collect::<String>());
        }
    }

    #[test]
    #[ignore]
    fn dry_run_over_the_real_worktree_root() {
        let plan = reap_dry_run();
        println!("root={} scanned={} reapable={} ({})", plan.root, plan.scanned, plan.reapable, human_bytes(plan.reapable_bytes));
        for line in &plan.lines {
            println!("{line}");
        }
    }

    #[test]
    fn worktree_diff_vs_base_spans_committed_and_uncommitted_work() {
        let repo = scratch_repo();
        let p = repo.path().to_str().unwrap();
        git(p, &["checkout", "-b", "operator/y"]).unwrap();
        // Committed lane work…
        std::fs::write(repo.path().join("a.txt"), "one\ncommitted\n").unwrap();
        git(p, &["add", "-A"]).unwrap();
        git(p, &["commit", "-m", "committed part"]).unwrap();
        // …plus an uncommitted edit on top.
        std::fs::write(repo.path().join("c.txt"), "uncommitted\n").unwrap();

        // Vs HEAD (default): only the uncommitted file shows.
        let head = worktree_diff(p, None);
        assert_eq!(head.files.iter().filter(|f| f.added + f.removed > 0).count(), 1);

        // Vs base: the committed edit shows too.
        let base = worktree_diff(p, Some("main"));
        assert!(base.files.iter().any(|f| f.path == "a.txt" && f.added == 1));
        assert!(base.files.iter().any(|f| f.path == "c.txt"));
        assert!(base.diff.contains("+committed") && base.diff.contains("+uncommitted"));
    }
}
