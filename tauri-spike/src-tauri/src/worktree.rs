// Git worktree operations (port of worktree.ts). Each agent session can run in
// an isolated worktree under ~/.operator/worktrees, with in-app diff/merge/discard.

use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

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

pub fn create_worktree(source_cwd: &str) -> Result<WorktreeCreateResult, String> {
    let info = inspect_repo(source_cwd);
    let root = match (info.is_repo, info.root) {
        (true, Some(r)) => r,
        _ => return Err("Not a git repository".into()),
    };
    git(&root, &["rev-parse", "HEAD"])
        .map_err(|_| "Repository has no commits yet — make an initial commit before using worktrees".to_string())?;

    let project = root.rsplit('/').next().unwrap_or("project").to_string();
    let short = short_id();
    let branch = format!("operator/{short}");
    let path = worktree_root().join(format!("{project}-{short}"));
    let path_str = path.to_string_lossy().to_string();

    std::fs::create_dir_all(worktree_root()).map_err(|e| e.to_string())?;
    git(&root, &["worktree", "add", "-b", &branch, &path_str, "HEAD"])?;

    Ok(WorktreeCreateResult { path: path_str, branch, base_branch: info.branch })
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

pub fn worktree_diff(path: &str) -> WorktreeDiff {
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

    if let Ok(numstat) = git(path, &["diff", "HEAD", "--numstat"]) {
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

    let mut diff = git(path, &["diff", "HEAD", "--no-color"]).unwrap_or_default();

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

pub fn remove_worktree(path: &str, source_root: &str) -> Result<(), String> {
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
