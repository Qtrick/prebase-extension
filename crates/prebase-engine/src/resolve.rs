//! Deterministic import resolution adapted from older graphs/src/core/resolution.
//! Never invents a target from a similar filename.

use std::collections::HashMap;
use std::path::{Component, Path};

use crate::domain::ResolutionStatus;
use crate::extract::{ExtractedImport, ImportForm};

const RESOLVE_EXTENSIONS: &[&str] = &[
    "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".rs",
];

#[derive(Debug, Clone)]
pub struct ResolvedImport {
    pub specifier: String,
    pub status: ResolutionStatus,
    /// Workspace-relative posix path when resolved.
    pub target_relative: Option<String>,
    pub line: u32,
    pub column: u32,
}

pub struct ResolutionIndex {
    /// relative posix path -> exists
    paths: HashMap<String, ()>,
}

impl ResolutionIndex {
    pub fn new(relative_paths: impl IntoIterator<Item = String>) -> Self {
        let mut paths = HashMap::new();
        for p in relative_paths {
            paths.insert(normalize_rel(&p), ());
        }
        Self { paths }
    }

    fn has(&self, path: &str) -> bool {
        self.paths.contains_key(path)
    }
}

pub fn normalize_rel(path: &str) -> String {
    let mut out = Vec::new();
    for part in path.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other.to_string()),
        }
    }
    out.join("/")
}

fn join_rel(base_dir: &str, rel: &str) -> String {
    if base_dir.is_empty() {
        normalize_rel(rel)
    } else {
        normalize_rel(&format!("{base_dir}/{rel}"))
    }
}

fn parent_dir(relative_file: &str) -> String {
    Path::new(relative_file)
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_string_lossy().to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn parent_of_dir(dir: &str) -> String {
    let parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() <= 1 {
        String::new()
    } else {
        parts[..parts.len() - 1].join("/")
    }
}

fn try_resolve_candidate(index: &ResolutionIndex, base: &str) -> Option<String> {
    let normalized = normalize_rel(base);
    if index.has(&normalized) {
        return Some(normalized);
    }
    for ext in RESOLVE_EXTENSIONS.iter().skip(1) {
        let file = format!("{normalized}{ext}");
        if index.has(&file) {
            return Some(file);
        }
    }
    let prefix = if normalized.is_empty() {
        String::new()
    } else {
        format!("{normalized}/")
    };
    for ext in RESOLVE_EXTENSIONS.iter().skip(1) {
        let index_path = format!("{prefix}index{ext}");
        if index.has(&index_path) {
            return Some(index_path);
        }
    }
    // Rust mod foo -> foo.rs or foo/mod.rs
    let rs = format!("{normalized}.rs");
    if index.has(&rs) {
        return Some(rs);
    }
    let mod_rs = format!("{normalized}/mod.rs");
    if index.has(&mod_rs) {
        return Some(mod_rs);
    }
    None
}

fn is_relative_specifier(spec: &str) -> bool {
    spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == ".."
}

fn is_path_mapping_or_absolute(spec: &str) -> bool {
    spec.starts_with('/') || spec.starts_with('@')
}

fn first_rust_module_segment(rest: &str) -> Option<String> {
    rest.split("::")
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

pub fn resolve_import(
    from_relative: &str,
    import: &ExtractedImport,
    index: &ResolutionIndex,
) -> ResolvedImport {
    let specifier = import.specifier.clone();

    match import.kind {
        ImportForm::RustMod => {
            let name = specifier.strip_prefix("mod:").unwrap_or(&specifier);
            let dir = parent_dir(from_relative);
            let candidate = if dir.is_empty() {
                name.to_string()
            } else {
                format!("{dir}/{name}")
            };
            return match try_resolve_candidate(index, &candidate) {
                Some(target) => ResolvedImport {
                    specifier,
                    status: ResolutionStatus::Resolved,
                    target_relative: Some(target),
                    line: import.line,
                    column: import.column,
                },
                None => ResolvedImport {
                    specifier,
                    status: ResolutionStatus::Unresolved,
                    target_relative: None,
                    line: import.line,
                    column: import.column,
                },
            };
        }
        ImportForm::RustUse => {
            // crate::module::item → try module.rs under crate root / src
            if let Some(rest) = specifier.strip_prefix("crate::") {
                if let Some(first) = first_rust_module_segment(rest) {
                    for base in ["src", "crates", ""] {
                        let cand = if base.is_empty() {
                            first.clone()
                        } else {
                            format!("{base}/{first}")
                        };
                        if let Some(target) = try_resolve_candidate(index, &cand) {
                            return ResolvedImport {
                                specifier,
                                status: ResolutionStatus::Resolved,
                                target_relative: Some(target),
                                line: import.line,
                                column: import.column,
                            };
                        }
                    }
                }
            } else if let Some(rest) = specifier.strip_prefix("self::") {
                if let Some(first) = first_rust_module_segment(rest) {
                    let dir = parent_dir(from_relative);
                    let candidate = join_rel(&dir, &first);
                    if let Some(target) = try_resolve_candidate(index, &candidate) {
                        return ResolvedImport {
                            specifier,
                            status: ResolutionStatus::Resolved,
                            target_relative: Some(target),
                            line: import.line,
                            column: import.column,
                        };
                    }
                }
            } else if let Some(rest) = specifier.strip_prefix("super::") {
                if let Some(first) = first_rust_module_segment(rest) {
                    let dir = parent_dir(from_relative);
                    let super_dir = parent_of_dir(&dir);
                    let candidate = join_rel(&super_dir, &first);
                    if let Some(target) = try_resolve_candidate(index, &candidate) {
                        return ResolvedImport {
                            specifier,
                            status: ResolutionStatus::Resolved,
                            target_relative: Some(target),
                            line: import.line,
                            column: import.column,
                        };
                    }
                }
            }
            return ResolvedImport {
                specifier,
                status: ResolutionStatus::Unresolved,
                target_relative: None,
                line: import.line,
                column: import.column,
            };
        }
        _ => {}
    }

    if is_relative_specifier(&specifier) {
        let dir = parent_dir(from_relative);
        let joined = join_rel(&dir, &specifier);
        return match try_resolve_candidate(index, &joined) {
            Some(target) => ResolvedImport {
                specifier,
                status: ResolutionStatus::Resolved,
                target_relative: Some(target),
                line: import.line,
                column: import.column,
            },
            None => ResolvedImport {
                specifier,
                status: ResolutionStatus::Unresolved,
                target_relative: None,
                line: import.line,
                column: import.column,
            },
        };
    }

    // Bare package / alias / absolute — not silently mapped to a similar file.
    if is_path_mapping_or_absolute(&specifier) || !specifier.contains('/') {
        return ResolvedImport {
            specifier,
            status: ResolutionStatus::External,
            target_relative: None,
            line: import.line,
            column: import.column,
        };
    }

    // Non-relative path-like (e.g. "src/foo") — try as workspace-relative, else external.
    match try_resolve_candidate(index, &specifier) {
        Some(target) => ResolvedImport {
            specifier,
            status: ResolutionStatus::Resolved,
            target_relative: Some(target),
            line: import.line,
            column: import.column,
        },
        None => ResolvedImport {
            specifier,
            status: ResolutionStatus::External,
            target_relative: None,
            line: import.line,
            column: import.column,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::{ExtractedImport, ImportForm};

    fn idx(paths: &[&str]) -> ResolutionIndex {
        ResolutionIndex::new(paths.iter().map(|s| (*s).to_string()))
    }

    #[test]
    fn resolves_relative_ts() {
        let index = idx(&["src/a.ts", "src/foo.ts", "src/nested/index.ts"]);
        let imp = ExtractedImport {
            specifier: "./foo".into(),
            line: 1,
            column: 1,
            kind: ImportForm::EsImport,
        };
        let r = resolve_import("src/a.ts", &imp, &index);
        assert_eq!(r.status, ResolutionStatus::Resolved);
        assert_eq!(r.target_relative.as_deref(), Some("src/foo.ts"));
    }

    #[test]
    fn does_not_invent_similar_name() {
        let index = idx(&["src/utils.ts"]);
        let imp = ExtractedImport {
            specifier: "./util".into(),
            line: 1,
            column: 1,
            kind: ImportForm::EsImport,
        };
        let r = resolve_import("src/a.ts", &imp, &index);
        assert_eq!(r.status, ResolutionStatus::Unresolved);
    }

    #[test]
    fn package_import_is_external() {
        let index = idx(&["src/a.ts"]);
        let imp = ExtractedImport {
            specifier: "react".into(),
            line: 1,
            column: 1,
            kind: ImportForm::EsImport,
        };
        let r = resolve_import("src/a.ts", &imp, &index);
        assert_eq!(r.status, ResolutionStatus::External);
    }

    #[test]
    fn resolves_index_file() {
        let index = idx(&["src/a.ts", "src/nested/index.ts"]);
        let imp = ExtractedImport {
            specifier: "./nested".into(),
            line: 1,
            column: 1,
            kind: ImportForm::EsImport,
        };
        let r = resolve_import("src/a.ts", &imp, &index);
        assert_eq!(r.target_relative.as_deref(), Some("src/nested/index.ts"));
    }

    #[test]
    fn resolves_rust_mod_declaration() {
        let index = idx(&["src/lib.rs", "src/foo/mod.rs"]);
        let imp = ExtractedImport {
            specifier: "mod:foo".into(),
            line: 2,
            column: 1,
            kind: ImportForm::RustMod,
        };
        let r = resolve_import("src/lib.rs", &imp, &index);
        assert_eq!(r.status, ResolutionStatus::Resolved);
        assert_eq!(r.target_relative.as_deref(), Some("src/foo/mod.rs"));
    }

    #[test]
    fn resolves_crate_relative_use() {
        let index = idx(&["src/main.rs", "src/domain.rs"]);
        let imp = ExtractedImport {
            specifier: "crate::domain".into(),
            line: 1,
            column: 1,
            kind: ImportForm::RustUse,
        };
        let r = resolve_import("src/main.rs", &imp, &index);
        assert_eq!(r.status, ResolutionStatus::Resolved);
        assert_eq!(r.target_relative.as_deref(), Some("src/domain.rs"));
    }

    #[test]
    fn workspace_relative_path_resolves_without_dot_prefix() {
        let index = idx(&["src/a.ts", "src/deep/util.ts"]);
        let imp = ExtractedImport {
            specifier: "src/deep/util".into(),
            line: 1,
            column: 1,
            kind: ImportForm::EsImport,
        };
        let r = resolve_import("src/a.ts", &imp, &index);
        assert_eq!(r.status, ResolutionStatus::Resolved);
        assert_eq!(r.target_relative.as_deref(), Some("src/deep/util.ts"));
    }

    #[test]
    fn resolves_rust_self_and_super() {
        let index = idx(&["src/foo/bar.rs", "src/foo/baz.rs", "src/qux.rs"]);
        let self_imp = ExtractedImport {
            specifier: "self::baz".into(),
            line: 1,
            column: 1,
            kind: ImportForm::RustUse,
        };
        let r = resolve_import("src/foo/bar.rs", &self_imp, &index);
        assert_eq!(r.status, ResolutionStatus::Resolved);
        assert_eq!(r.target_relative.as_deref(), Some("src/foo/baz.rs"));

        let super_imp = ExtractedImport {
            specifier: "super::qux".into(),
            line: 2,
            column: 1,
            kind: ImportForm::RustUse,
        };
        let r2 = resolve_import("src/foo/bar.rs", &super_imp, &index);
        assert_eq!(r2.status, ResolutionStatus::Resolved);
        assert_eq!(r2.target_relative.as_deref(), Some("src/qux.rs"));
    }
}
