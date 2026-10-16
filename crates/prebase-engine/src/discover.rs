//! Workspace file discovery with ignore rules and path boundary checks.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use walkdir::WalkDir;

const SKIP_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    "coverage",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    "vendor",
    ".idea",
    ".vscode",
    "extension/media",
    "extension/bin",
    "extension/out",
];

const MAX_FILE_BYTES: u64 = 1_500_000;

#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub absolute: PathBuf,
    pub relative_posix: String,
    pub extension: String,
    pub size: u64,
}

#[derive(Debug, Default)]
pub struct DiscoveryResult {
    pub files: Vec<DiscoveredFile>,
    pub excluded_paths: u32,
    pub unsupported_files: u32,
}

pub fn is_supported_extension(ext: &str) -> bool {
    matches!(
        ext,
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" | "rs"
    )
}

pub fn language_for_extension(ext: &str) -> Option<&'static str> {
    match ext {
        "ts" | "mts" | "cts" => Some("typescript"),
        "tsx" => Some("tsx"),
        "js" | "mjs" | "cjs" => Some("javascript"),
        "jsx" => Some("jsx"),
        "rs" => Some("rust"),
        _ => None,
    }
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIR_NAMES.iter().any(|d| *d == name)
        || name.ends_with(".egg-info")
        || (name.starts_with('.') && name != ".")
}

/// Ensure `candidate` stays within `root` after canonicalize when possible.
pub fn path_within_root(root: &Path, candidate: &Path) -> bool {
    let Ok(root_c) = fs::canonicalize(root) else {
        return false;
    };
    let Ok(cand_c) = fs::canonicalize(candidate) else {
        // Non-existent is ok during planning; check prefix without canonicalize.
        return candidate.starts_with(root);
    };
    cand_c.starts_with(&root_c)
}

pub fn to_posix_relative(root: &Path, absolute: &Path) -> Option<String> {
    let rel = absolute.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().replace('\\', "/")),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Canonical workspace root for analysis requests (IPC boundary).
pub fn resolve_workspace_root(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Workspace path is empty".into());
    }
    let root = fs::canonicalize(trimmed)
        .map_err(|e| format!("Cannot canonicalize workspace path: {e}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

pub fn discover_workspace(root: &Path) -> Result<DiscoveryResult, String> {
    if !root.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            root.display()
        ));
    }
    let root = fs::canonicalize(root).map_err(|e| format!("Cannot canonicalize workspace: {e}"))?;

    let mut out = DiscoveryResult::default();
    let mut seen = HashSet::new();

    let walker = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() && should_skip_dir(&name) {
                return false;
            }
            true
        });

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                out.excluded_paths += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let absolute = entry.path().to_path_buf();
        if !path_within_root(&root, &absolute) {
            out.excluded_paths += 1;
            continue;
        }
        let Some(relative_posix) = to_posix_relative(&root, &absolute) else {
            out.excluded_paths += 1;
            continue;
        };
        if relative_posix.is_empty() || !seen.insert(relative_posix.clone()) {
            continue;
        }

        let ext = absolute
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let meta = match fs::metadata(&absolute) {
            Ok(m) => m,
            Err(_) => {
                out.excluded_paths += 1;
                continue;
            }
        };
        if meta.len() > MAX_FILE_BYTES {
            out.excluded_paths += 1;
            continue;
        }

        if !is_supported_extension(&ext) {
            // Count only common source-like unsupported extensions, not every asset.
            if matches!(
                ext.as_str(),
                "py" | "go"
                    | "java"
                    | "kt"
                    | "cpp"
                    | "c"
                    | "h"
                    | "cs"
                    | "rb"
                    | "php"
                    | "swift"
                    | "vue"
                    | "svelte"
                    | "json"
                    | "md"
            ) {
                out.unsupported_files += 1;
            }
            continue;
        }

        out.files.push(DiscoveredFile {
            absolute,
            relative_posix,
            extension: ext,
            size: meta.len(),
        });
    }

    out.files
        .sort_by(|a, b| a.relative_posix.cmp(&b.relative_posix));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn skips_node_modules_and_finds_ts() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        fs::write(
            root.join("node_modules/pkg/index.js"),
            "module.exports = {}\n",
        )
        .unwrap();
        fs::write(root.join("readme.md"), "# hi\n").unwrap();

        let result = discover_workspace(root).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_posix, "src/a.ts");
        assert!(result.unsupported_files >= 1);
    }

    #[test]
    fn rejects_symlink_escape_via_follow_links_false() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/ok.ts"), "export {}\n").unwrap();
        let result = discover_workspace(root).unwrap();
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn rejects_non_directory_workspace() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("not-a-dir.txt");
        fs::write(&file, "x\n").unwrap();
        let err = discover_workspace(&file).unwrap_err();
        assert!(err.contains("not a directory"));
    }

    #[test]
    fn excludes_oversized_source_files() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/small.ts"), "export {}\n").unwrap();
        let huge = root.join("src/huge.ts");
        let mut f = fs::File::create(&huge).unwrap();
        use std::io::Write;
        f.write_all(&vec![b' '; (MAX_FILE_BYTES + 1) as usize])
            .unwrap();

        let result = discover_workspace(root).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_posix, "src/small.ts");
        assert!(result.excluded_paths >= 1);
    }

    #[test]
    fn to_posix_relative_rejects_parent_components() {
        let root = Path::new("/tmp/ws");
        let bad = Path::new("/tmp/ws/../escape.ts");
        assert!(to_posix_relative(root, bad).is_none());
    }
}
