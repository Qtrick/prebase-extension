//! PreBase analysis engine — stdio JSON-lines server.
//!
//! Protocol: one JSON object per line on stdout.
//! Diagnostics: stderr only.

mod analyze;
mod delta;
mod digest;
mod discover;
mod domain;
mod extract;
mod fixture;
mod git;
mod protocol;
mod resolve;
mod sources;
mod store;
mod temporal;

use std::io::{self, BufRead, Write};

use protocol::{
    encode_response, parse_request_line, EngineCapabilities, EngineRequest, EngineResponse,
    ErrorCategory, GetNetworkGraphParams, GetNetworkGraphResult, InitializeResult,
    PROTOCOL_VERSION,
};

const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();

    eprintln_log(&mut stderr, "prebase-engine starting");

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln_log(&mut stderr, &format!("stdin read error: {e}"));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = match parse_request_line(&line) {
            Ok(req) => handle_request(req, &mut stderr),
            Err(protocol::ProtocolError::Oversized) => EngineResponse::err(
                "unknown",
                ErrorCategory::InvalidRequest,
                "Message exceeds size limit",
            ),
            Err(protocol::ProtocolError::Malformed(msg)) => EngineResponse::err(
                "unknown",
                ErrorCategory::InvalidRequest,
                format!("Malformed request: {msg}"),
            ),
        };

        if let Err(e) = write_response(&mut stdout, &response) {
            eprintln_log(&mut stderr, &format!("stdout write error: {e}"));
            break;
        }
    }

    eprintln_log(&mut stderr, "prebase-engine shutting down");
}

fn handle_request(req: EngineRequest, stderr: &mut impl Write) -> EngineResponse {
    if req.protocol_version != PROTOCOL_VERSION {
        return EngineResponse::err(
            req.id,
            ErrorCategory::UnsupportedVersion,
            format!(
                "Unsupported protocol version {}; engine supports {PROTOCOL_VERSION}",
                req.protocol_version
            ),
        );
    }

    match req.method.as_str() {
        "initialize" => EngineResponse::ok(
            req.id,
            InitializeResult {
                engine_version: ENGINE_VERSION.into(),
                protocol_version: PROTOCOL_VERSION,
                capabilities: EngineCapabilities {
                    network_graph: true,
                    temporal_graph: true,
                    fixture_graph: true,
                },
            },
        ),
        "shutdown" => EngineResponse::ok(req.id, serde_json::json!({ "ok": true })),
        "listTemporalHistory" => {
            match serde_json::from_value::<protocol::TemporalHistoryParams>(req.params) {
                Ok(params) => match temporal::list_timeline(
                    &params.workspace_path,
                    &params.storage_path,
                    params.limit,
                ) {
                    Ok((timeline, is_shallow)) => EngineResponse::ok(
                        req.id,
                        serde_json::json!({
                            "timeline": timeline,
                            "isShallow": is_shallow,
                            "note": "First-parent timeline. Indexing required for complete snapshots."
                        }),
                    ),
                    Err(message) => {
                        EngineResponse::err(req.id, ErrorCategory::AnalysisUnavailable, message)
                    }
                },
                Err(e) => EngineResponse::err(
                    req.id,
                    ErrorCategory::InvalidRequest,
                    format!("Invalid listTemporalHistory params: {e}"),
                ),
            }
        }
        "indexTemporalHistory" => {
            match serde_json::from_value::<protocol::TemporalHistoryParams>(req.params.clone()) {
                Ok(params) => {
                    eprintln_log(
                        stderr,
                        &format!("indexing temporal history {}", params.workspace_path),
                    );
                    match temporal::index_history(
                        &params.workspace_path,
                        &params.storage_path,
                        params.limit,
                    ) {
                        Ok(result) => EngineResponse::ok(req.id, result),
                        Err(message) => {
                            EngineResponse::err(req.id, ErrorCategory::AnalysisUnavailable, message)
                        }
                    }
                }
                Err(e) => EngineResponse::err(
                    req.id,
                    ErrorCategory::InvalidRequest,
                    format!("Invalid indexTemporalHistory params: {e}"),
                ),
            }
        }
        "getTemporalSnapshot" => {
            match serde_json::from_value::<protocol::TemporalSnapshotParams>(req.params) {
                Ok(params) => match temporal::get_snapshot(
                    &params.workspace_path,
                    &params.storage_path,
                    &params.commit_oid,
                ) {
                    Ok(result) => EngineResponse::ok(req.id, result),
                    Err(message) => {
                        EngineResponse::err(req.id, ErrorCategory::AnalysisUnavailable, message)
                    }
                },
                Err(e) => EngineResponse::err(
                    req.id,
                    ErrorCategory::InvalidRequest,
                    format!("Invalid getTemporalSnapshot params: {e}"),
                ),
            }
        }
        "compareTemporalSnapshots" => {
            match serde_json::from_value::<protocol::TemporalCompareParams>(req.params) {
                Ok(params) => {
                    match temporal::compare_snapshots(
                        &params.storage_path,
                        &params.base_commit_oid,
                        &params.target_commit_oid,
                    ) {
                        Ok((delta, base_graph, target_graph)) => EngineResponse::ok(
                            req.id,
                            serde_json::json!({
                                "delta": delta,
                                "baseGraph": base_graph,
                                "targetGraph": target_graph,
                            }),
                        ),
                        Err(message) => {
                            EngineResponse::err(req.id, ErrorCategory::AnalysisUnavailable, message)
                        }
                    }
                }
                Err(e) => EngineResponse::err(
                    req.id,
                    ErrorCategory::InvalidRequest,
                    format!("Invalid compareTemporalSnapshots params: {e}"),
                ),
            }
        }
        "getNetworkGraph" => match serde_json::from_value::<GetNetworkGraphParams>(req.params) {
            Ok(params) => {
                if params.prefer_fixture {
                    let graph = fixture::sample_network_graph(&params.workspace_path);
                    return EngineResponse::ok(req.id, GetNetworkGraphResult { graph });
                }

                if params.workspace_path.trim().is_empty() {
                    return EngineResponse::err(
                        req.id,
                        ErrorCategory::InvalidRequest,
                        "workspacePath is required when preferFixture is false",
                    );
                }

                eprintln_log(
                    stderr,
                    &format!("analyzing workspace {}", params.workspace_path),
                );
                match analyze::analyze_workspace_opts(&params.workspace_path, params.force_refresh)
                {
                    Ok(graph) => {
                        eprintln_log(
                            stderr,
                            &format!(
                                "analysis complete nodes={} edges={} resolved={} unresolved={} {}ms",
                                graph.nodes.len(),
                                graph.edges.len(),
                                graph.coverage.resolved_imports,
                                graph.coverage.unresolved_imports,
                                graph.coverage.duration_ms
                            ),
                        );
                        EngineResponse::ok(req.id, GetNetworkGraphResult { graph })
                    }
                    Err(message) => {
                        EngineResponse::err(req.id, ErrorCategory::AnalysisUnavailable, message)
                    }
                }
            }
            Err(e) => EngineResponse::err(
                req.id,
                ErrorCategory::InvalidRequest,
                format!("Invalid getNetworkGraph params: {e}"),
            ),
        },
        "ping" => EngineResponse::ok(req.id, serde_json::json!({ "pong": true })),
        other => EngineResponse::err(
            req.id,
            ErrorCategory::UnknownMethod,
            format!("Unknown method: {other}"),
        ),
    }
}

fn write_response(stdout: &mut impl Write, response: &EngineResponse) -> io::Result<()> {
    let encoded = encode_response(response).map_err(io::Error::other)?;
    stdout.write_all(encoded.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn eprintln_log(stderr: &mut impl Write, msg: &str) {
    let _ = writeln!(stderr, "[prebase-engine] {msg}");
    let _ = stderr.flush();
}

#[cfg(test)]
mod integration {
    use super::*;
    use crate::domain::{CanonicalGraph, GraphProvenance};
    use protocol::parse_request_line;
    use std::io::sink;

    fn handle(req: EngineRequest) -> EngineResponse {
        handle_request(req, &mut sink())
    }

    #[test]
    fn initialize_then_fixture_graph() {
        let init = parse_request_line(
            r#"{"protocolVersion":1,"id":"a","method":"initialize","params":{}}"#,
        )
        .unwrap();
        assert!(handle(init).error.is_none());

        let graph_req = parse_request_line(
            r#"{"protocolVersion":1,"id":"b","method":"getNetworkGraph","params":{"workspacePath":"/tmp/ws","preferFixture":true}}"#,
        )
        .unwrap();
        let resp = handle(graph_req);
        let result = resp.result.expect("graph result");
        let graph: CanonicalGraph =
            serde_json::from_value(result.get("graph").cloned().unwrap()).unwrap();
        assert_eq!(graph.provenance, GraphProvenance::Fixture);
        let encoded = serde_json::to_string(&graph).unwrap();
        assert!(encoded.contains("\"analyzedFiles\""));
        assert!(encoded.contains("\"discoveredFiles\""));
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let req =
            parse_request_line(r#"{"protocolVersion":1,"id":"x","method":"nope","params":{}}"#)
                .unwrap();
        assert_eq!(
            handle(req).error.unwrap().category,
            ErrorCategory::UnknownMethod
        );
    }

    #[test]
    fn unsupported_protocol_version_is_rejected() {
        let req = parse_request_line(
            r#"{"protocolVersion":99,"id":"v","method":"initialize","params":{}}"#,
        )
        .unwrap();
        let err = handle(req).error.expect("expected error");
        assert_eq!(err.category, ErrorCategory::UnsupportedVersion);
    }

    #[test]
    fn invalid_get_network_graph_params_is_invalid_request() {
        let req = parse_request_line(
            r#"{"protocolVersion":1,"id":"g","method":"getNetworkGraph","params":{"preferFixture":true}}"#,
        )
        .unwrap();
        assert_eq!(
            handle(req).error.expect("expected error").category,
            ErrorCategory::InvalidRequest
        );
    }

    #[test]
    fn get_network_graph_force_refresh_rebuilds_workspace_graph() {
        use std::fs;
        use tempfile::tempdir;

        analyze::clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        let ws = root.to_str().unwrap();

        let warm = parse_request_line(&format!(
            r#"{{"protocolVersion":1,"id":"w","method":"getNetworkGraph","params":{{"workspacePath":"{ws}","preferFixture":false}}}}"#
        ))
        .unwrap();
        assert!(handle(warm).error.is_none());

        let refresh = parse_request_line(&format!(
            r#"{{"protocolVersion":1,"id":"f","method":"getNetworkGraph","params":{{"workspacePath":"{ws}","preferFixture":false,"forceRefresh":true}}}}"#
        ))
        .unwrap();
        let resp = handle(refresh);
        let result = resp.result.expect("graph result");
        let graph: CanonicalGraph =
            serde_json::from_value(result.get("graph").cloned().unwrap()).unwrap();
        assert!(graph
            .provenance_note
            .as_deref()
            .unwrap_or("")
            .contains("force_refresh"));
    }
}
