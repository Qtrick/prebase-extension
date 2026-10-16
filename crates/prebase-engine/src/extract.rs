//! Import extraction via Tree-sitter (TS/JS/TSX/JSX) and a small Rust scanner.

use streaming_iterator::StreamingIterator;
use tree_sitter::{Parser, Query, QueryCursor};

use crate::discover::language_for_extension;

#[derive(Debug, Clone)]
pub struct ExtractedImport {
    pub specifier: String,
    pub line: u32,
    pub column: u32,
    pub kind: ImportForm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportForm {
    EsImport,
    Require,
    RustUse,
    RustMod,
}

#[derive(Debug, Clone)]
pub struct FileExtraction {
    pub imports: Vec<ExtractedImport>,
    pub parse_error: bool,
}

const TS_IMPORT_QUERY: &str = r#"
(import_statement source: (string) @spec)
(export_statement source: (string) @spec)
(call_expression
  function: (identifier) @fn
  arguments: (arguments (string) @spec)
  (#eq? @fn "require"))
(call_expression
  function: (import)
  arguments: (arguments (string) @spec))
"#;

fn strip_quotes(s: &str) -> String {
    s.trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_string()
}

fn parse_with_language(source: &str, language: tree_sitter::Language) -> FileExtraction {
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return FileExtraction {
            imports: vec![],
            parse_error: true,
        };
    }
    let Some(tree) = parser.parse(source, None) else {
        return FileExtraction {
            imports: vec![],
            parse_error: true,
        };
    };
    let root = tree.root_node();
    let parse_error = root.has_error();

    let Ok(query) = Query::new(&language, TS_IMPORT_QUERY) else {
        return FileExtraction {
            imports: vec![],
            parse_error: true,
        };
    };

    let mut cursor = QueryCursor::new();
    let mut imports = Vec::new();
    let bytes = source.as_bytes();

    let mut matches = cursor.matches(&query, root, bytes);
    while let Some(m) = matches.next() {
        let mut spec: Option<String> = None;
        let mut is_require = false;
        let mut node_for_loc = None;
        for cap in m.captures {
            let name = query.capture_names()[cap.index as usize];
            let text = cap.node.utf8_text(bytes).unwrap_or("");
            match name {
                "spec" => {
                    spec = Some(strip_quotes(text));
                    node_for_loc = Some(cap.node);
                }
                "fn" if text == "require" => is_require = true,
                _ => {}
            }
        }
        let Some(specifier) = spec else { continue };
        if specifier.is_empty() {
            continue;
        }
        let (line, column) = node_for_loc
            .map(|n| {
                let p = n.start_position();
                (p.row as u32 + 1, p.column as u32 + 1)
            })
            .unwrap_or((1, 1));
        let kind = if is_require {
            ImportForm::Require
        } else {
            ImportForm::EsImport
        };
        imports.push(ExtractedImport {
            specifier,
            line,
            column,
            kind,
        });
    }

    imports.sort_by(|a, b| (a.line, a.column, &a.specifier).cmp(&(b.line, b.column, &b.specifier)));
    imports.dedup_by(|a, b| a.specifier == b.specifier && a.line == b.line);

    FileExtraction {
        imports,
        parse_error,
    }
}

fn extract_rust(source: &str) -> FileExtraction {
    let mut imports = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("mod ") {
            let name = rest.trim().trim_end_matches(';').trim();
            if !name.is_empty() && !name.contains('{') && name.is_ascii() {
                imports.push(ExtractedImport {
                    specifier: format!("mod:{name}"),
                    line: idx as u32 + 1,
                    column: 1,
                    kind: ImportForm::RustMod,
                });
            }
        }
        if let Some(rest) = trimmed.strip_prefix("use ") {
            let path = rest
                .trim()
                .trim_end_matches(';')
                .split(['{', ':', ' '])
                .next()
                .unwrap_or("")
                .trim();
            // Only crate-local paths participate in workspace resolution.
            if path == "crate" || path == "super" || path == "self" {
                imports.push(ExtractedImport {
                    specifier: rest.trim().trim_end_matches(';').to_string(),
                    line: idx as u32 + 1,
                    column: 1,
                    kind: ImportForm::RustUse,
                });
            }
        }
    }
    FileExtraction {
        imports,
        parse_error: false,
    }
}

pub fn extract_imports(relative_path: &str, extension: &str, source: &str) -> FileExtraction {
    let _ = relative_path;
    match language_for_extension(extension) {
        Some("typescript") | Some("javascript") => {
            parse_with_language(source, tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
        }
        Some("tsx") | Some("jsx") => {
            parse_with_language(source, tree_sitter_typescript::LANGUAGE_TSX.into())
        }
        Some("rust") => extract_rust(source),
        _ => FileExtraction {
            imports: vec![],
            parse_error: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_ts_imports() {
        let src = r#"
import { x } from './foo';
import type { Y } from "../bar";
const z = require("./cjs");
export { a } from './reexport';
"#;
        let result = extract_imports("src/a.ts", "ts", src);
        let specs: Vec<_> = result
            .imports
            .iter()
            .map(|i| i.specifier.as_str())
            .collect();
        assert!(specs.contains(&"./foo"));
        assert!(specs.contains(&"../bar"));
        assert!(specs.contains(&"./cjs"));
        assert!(specs.contains(&"./reexport"));
        assert!(!result.parse_error);
    }

    #[test]
    fn malformed_ts_does_not_panic() {
        let src = "import { from './broken\nconst x = 1;";
        let result = extract_imports("bad.ts", "ts", src);
        // May report parse_error; must not panic.
        let _ = result;
    }

    #[test]
    fn extracts_rust_mod() {
        let src = "mod resolve;\nuse crate::domain::GraphNode;\nuse serde::Serialize;\n";
        let result = extract_imports("lib.rs", "rs", src);
        assert!(result.imports.iter().any(|i| i.specifier == "mod:resolve"));
        assert!(result
            .imports
            .iter()
            .any(|i| i.kind == ImportForm::RustUse && i.specifier.starts_with("crate")));
        assert!(!result.imports.iter().any(|i| i.specifier.contains("serde")));
    }
}
