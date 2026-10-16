//! Local SQLite persistence for temporal snapshots (outside the user's repo).

use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::{CanonicalGraph, ANALYZER_VERSION, TEMPORAL_SCHEMA_VERSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotStatus {
    Complete,
    Failed,
    Incomplete,
}

impl SnapshotStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Failed => "failed",
            Self::Incomplete => "incomplete",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "complete" => Self::Complete,
            "failed" => Self::Failed,
            _ => Self::Incomplete,
        }
    }
}

pub struct TemporalStore {
    conn: Connection,
}

/// Validate extension-provided storage directory (outside the user's repo).
pub fn resolve_storage_dir(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("storagePath is required".into());
    }
    if trimmed.bytes().any(|b| b == 0) {
        return Err("storagePath contains invalid characters".into());
    }
    let p = PathBuf::from(trimmed);
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("storagePath must not contain '..' path components".into());
    }
    if p.file_name().is_some_and(|n| n == ".git") {
        return Err("storagePath must not point at a .git directory".into());
    }
    Ok(p)
}

impl TemporalStore {
    pub fn open(storage_dir: &Path) -> Result<Self, String> {
        let storage_dir = resolve_storage_dir(
            storage_dir
                .to_str()
                .ok_or_else(|| "storagePath is not valid UTF-8".to_string())?,
        )?;
        std::fs::create_dir_all(&storage_dir)
            .map_err(|e| format!("Cannot create storage dir: {e}"))?;
        let db_path = storage_dir.join("temporal.sqlite");
        let conn = Connection::open(&db_path).map_err(|e| format!("SQLite open failed: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("SQLite busy_timeout failed: {e}"))?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS graph_blobs (
              digest TEXT PRIMARY KEY,
              graph_json TEXT NOT NULL,
              analyzer_version INTEGER NOT NULL,
              schema_version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshots (
              commit_oid TEXT PRIMARY KEY,
              digest TEXT,
              status TEXT NOT NULL,
              error TEXT,
              parents_json TEXT NOT NULL,
              summary TEXT NOT NULL,
              author TEXT NOT NULL,
              time_seconds INTEGER NOT NULL,
              analyzer_version INTEGER NOT NULL,
              temporal_schema INTEGER NOT NULL
            );
            ",
        )
        .map_err(|e| format!("SQLite migrate failed: {e}"))?;

        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('temporal_schema', ?1)",
            params![TEMPORAL_SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;

        Ok(Self { conn })
    }

    pub fn get_complete_snapshot(
        &self,
        commit_oid: &str,
    ) -> Result<Option<(String, CanonicalGraph)>, String> {
        let row: Option<(String, String, i64, String)> = self
            .conn
            .query_row(
                "SELECT s.digest, g.graph_json, s.analyzer_version, s.status
                 FROM snapshots s
                 JOIN graph_blobs g ON g.digest = s.digest
                 WHERE s.commit_oid = ?1
                   AND s.status = 'complete'
                   AND s.digest IS NOT NULL",
                params![commit_oid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some((digest, json, analyzer_version, status)) = row else {
            return Ok(None);
        };
        if SnapshotStatus::parse(&status) != SnapshotStatus::Complete {
            return Ok(None);
        }
        if analyzer_version as u32 != ANALYZER_VERSION {
            return Ok(None);
        }
        let graph: CanonicalGraph =
            serde_json::from_str(&json).map_err(|e| format!("Corrupt graph blob: {e}"))?;
        Ok(Some((digest, graph)))
    }

    pub fn snapshot_status(&self, commit_oid: &str) -> Result<Option<SnapshotStatus>, String> {
        let status: Option<String> = self
            .conn
            .query_row(
                "SELECT status FROM snapshots WHERE commit_oid = ?1",
                params![commit_oid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(status.map(|s| SnapshotStatus::parse(&s)))
    }

    pub fn begin_incomplete(
        &self,
        commit_oid: &str,
        parents: &[String],
        summary: &str,
        author: &str,
        time_seconds: i64,
    ) -> Result<(), String> {
        let parents_json = serde_json::to_string(parents).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO snapshots(
                    commit_oid, digest, status, error, parents_json, summary, author,
                    time_seconds, analyzer_version, temporal_schema
                 ) VALUES (?1, NULL, 'incomplete', NULL, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    commit_oid,
                    parents_json,
                    summary,
                    author,
                    time_seconds,
                    ANALYZER_VERSION as i64,
                    TEMPORAL_SCHEMA_VERSION as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn publish_complete(
        &mut self,
        commit_oid: &str,
        digest: &str,
        graph: &CanonicalGraph,
        parents: &[String],
        summary: &str,
        author: &str,
        time_seconds: i64,
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let graph_json = serde_json::to_string(graph).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO graph_blobs(digest, graph_json, analyzer_version, schema_version)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                digest,
                graph_json,
                ANALYZER_VERSION as i64,
                TEMPORAL_SCHEMA_VERSION as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        let parents_json = serde_json::to_string(parents).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO snapshots(
                commit_oid, digest, status, error, parents_json, summary, author,
                time_seconds, analyzer_version, temporal_schema
             ) VALUES (?1, ?2, 'complete', NULL, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                commit_oid,
                digest,
                parents_json,
                summary,
                author,
                time_seconds,
                ANALYZER_VERSION as i64,
                TEMPORAL_SCHEMA_VERSION as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn publish_failed(&self, commit_oid: &str, error: &str) -> Result<(), String> {
        let updated = self
            .conn
            .execute(
                "UPDATE snapshots SET status = 'failed', error = ?2, digest = NULL WHERE commit_oid = ?1",
                params![commit_oid, error],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            self.conn
                .execute(
                    "INSERT INTO snapshots(
                        commit_oid, digest, status, error, parents_json, summary, author,
                        time_seconds, analyzer_version, temporal_schema
                     ) VALUES (?1, NULL, 'failed', ?2, '[]', '', '', 0, ?3, ?4)",
                    params![
                        commit_oid,
                        error,
                        ANALYZER_VERSION as i64,
                        TEMPORAL_SCHEMA_VERSION as i64
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn list_indexed(&self) -> Result<Vec<(String, SnapshotStatus, Option<String>)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT commit_oid, status, digest FROM snapshots ORDER BY time_seconds DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    SnapshotStatus::parse(&r.get::<_, String>(1)?),
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn incomplete_snapshot_is_not_returned_as_complete() {
        let dir = tempdir().unwrap();
        let store = TemporalStore::open(dir.path()).unwrap();
        let oid = "abcd1234abcd1234abcd1234abcd1234abcd1234";
        store
            .begin_incomplete(oid, &[], "indexing", "PreBase", 1_700_000_000)
            .unwrap();

        assert_eq!(
            store.snapshot_status(oid).unwrap(),
            Some(SnapshotStatus::Incomplete)
        );
        assert!(store.get_complete_snapshot(oid).unwrap().is_none());
    }
}
