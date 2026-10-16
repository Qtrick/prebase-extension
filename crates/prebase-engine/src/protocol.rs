//! Versioned JSON-lines protocol over stdin/stdout.
//! stdout is reserved for protocol messages; diagnostics go to stderr.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::domain::CanonicalGraph;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRequest {
    pub protocol_version: u32,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineResponse {
    pub protocol_version: u32,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<EngineErrorBody>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineErrorBody {
    pub category: ErrorCategory,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    InvalidRequest,
    UnsupportedVersion,
    UnknownMethod,
    EngineNotReady,
    AnalysisUnavailable,
    Timeout,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub engine_version: String,
    pub protocol_version: u32,
    pub capabilities: EngineCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    pub network_graph: bool,
    pub temporal_graph: bool,
    pub fixture_graph: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNetworkGraphParams {
    pub workspace_path: String,
    #[serde(default)]
    pub prefer_fixture: bool,
    /// Clear process caches and rebuild (manual recovery / force).
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNetworkGraphResult {
    pub graph: CanonicalGraph,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalHistoryParams {
    pub workspace_path: String,
    pub storage_path: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalSnapshotParams {
    pub workspace_path: String,
    pub storage_path: String,
    pub commit_oid: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalCompareParams {
    pub storage_path: String,
    pub base_commit_oid: String,
    pub target_commit_oid: String,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("message exceeds size limit")]
    Oversized,
    #[error("malformed JSON: {0}")]
    Malformed(String),
}

impl EngineResponse {
    pub fn ok(id: impl Into<String>, result: impl Serialize) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: id.into(),
            result: Some(serde_json::to_value(result).expect("result serializable")),
            error: None,
        }
    }

    pub fn err(id: impl Into<String>, category: ErrorCategory, message: impl Into<String>) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: id.into(),
            result: None,
            error: Some(EngineErrorBody {
                category,
                message: message.into(),
                details: None,
            }),
        }
    }
}

pub fn parse_request_line(line: &str) -> Result<EngineRequest, ProtocolError> {
    if line.len() > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::Oversized);
    }
    serde_json::from_str(line).map_err(|e| ProtocolError::Malformed(e.to_string()))
}

pub fn encode_response(response: &EngineResponse) -> Result<String, serde_json::Error> {
    serde_json::to_string(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_initialize_request() {
        let line = r#"{"protocolVersion":1,"id":"1","method":"initialize","params":{}}"#;
        let req = parse_request_line(line).unwrap();
        assert_eq!(req.method, "initialize");
        assert_eq!(req.id, "1");
    }

    #[test]
    fn rejects_oversized_message() {
        let huge = "x".repeat(MAX_MESSAGE_BYTES + 1);
        assert!(matches!(
            parse_request_line(&huge),
            Err(ProtocolError::Oversized)
        ));
    }

    #[test]
    fn error_response_roundtrip() {
        let resp = EngineResponse::err("r1", ErrorCategory::UnknownMethod, "nope");
        let encoded = encode_response(&resp).unwrap();
        let back: EngineResponse = serde_json::from_str(&encoded).unwrap();
        assert_eq!(back.error.unwrap().category, ErrorCategory::UnknownMethod);
    }

    #[test]
    fn get_network_graph_params_force_refresh_roundtrip() {
        let params: GetNetworkGraphParams = serde_json::from_str(
            r#"{"workspacePath":"/tmp/ws","forceRefresh":true,"preferFixture":false}"#,
        )
        .unwrap();
        assert!(params.force_refresh);
        assert!(!params.prefer_fixture);

        let default_params: GetNetworkGraphParams =
            serde_json::from_str(r#"{"workspacePath":"/tmp/ws"}"#).unwrap();
        assert!(!default_params.force_refresh);
        assert!(!default_params.prefer_fixture);

        let encoded = serde_json::to_string(&params).unwrap();
        assert!(encoded.contains("forceRefresh"));
        let back: GetNetworkGraphParams = serde_json::from_str(&encoded).unwrap();
        assert_eq!(back, params);
    }
}
