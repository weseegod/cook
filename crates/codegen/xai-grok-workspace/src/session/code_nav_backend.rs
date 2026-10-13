//! Codebase-index backend for the `code_nav` model tool.
//!
//! Wraps a [`CodebaseIndexManager`] behind the `xai_grok_tools`
//! `CodeNavBackend` trait, so a session's finalized toolset can expose
//! `code_nav` to the model. The ACP `code_nav` extension requires a web client
//! and an advertised capability; this path does not.
//!
//! The manager holds only `Weak` handles, so this backend keeps the strong
//! `Arc` for every root it has indexed. Without that pin the index would be
//! reaped between calls and every query would start a fresh build.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use xai_codebase_graph::{IndexManagerHandle, QueryResult, SymbolLocation};
use xai_grok_tools::implementations::grok_build::{CodeNavBackend, CodeNavLocation};

use crate::file_system::CodebaseIndexManager;

/// Resolves the codebase index for a working directory and answers navigation
/// queries against it.
pub struct CodeNavIndexBackend {
    indexes: Arc<parking_lot::Mutex<CodebaseIndexManager>>,
    /// Session working directory: resolves the relative paths the model passes.
    cwd: PathBuf,
    /// Index root: the git root of `cwd`, or `cwd` itself outside a repository.
    root: PathBuf,
    pinned: parking_lot::Mutex<HashMap<PathBuf, Arc<IndexManagerHandle>>>,
}

impl CodeNavIndexBackend {
    /// Pins the index at `cwd`'s git root, falling back to `cwd` itself when it
    /// is not inside a repository. `cwd` is the session working directory.
    pub fn new(indexes: Arc<parking_lot::Mutex<CodebaseIndexManager>>, cwd: PathBuf) -> Self {
        let root =
            crate::session::git::find_git_root_from_path(&cwd).unwrap_or_else(|_| cwd.clone());
        Self {
            indexes,
            cwd,
            root,
            pinned: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    /// The indexed root this backend answers from.
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// The index reads positions out of the file on disk, so a model-supplied
    /// relative path is resolved against the session working directory first.
    fn resolve_file(&self, file: &str) -> PathBuf {
        let path = PathBuf::from(file);
        if path.is_absolute() {
            path
        } else {
            self.cwd.join(path)
        }
    }

    fn handle(&self) -> Arc<IndexManagerHandle> {
        let mut pinned = self.pinned.lock();
        if let Some(handle) = pinned.get(&self.root) {
            return Arc::clone(handle);
        }
        let (handle, _) = self.indexes.lock().get_or_create(self.root.clone());
        pinned.insert(self.root.clone(), Arc::clone(&handle));
        handle
    }
}

fn symbol_location(location: SymbolLocation, fallback: Option<String>) -> CodeNavLocation {
    CodeNavLocation {
        path: location.path,
        line: location.line,
        symbol: location.matched_symbol.or(fallback),
    }
}

fn locations_from_query(result: QueryResult) -> Vec<CodeNavLocation> {
    result
        .locations
        .into_iter()
        .map(|location| symbol_location(location, Some(result.symbol.clone())))
        .collect()
}

fn locations_from_symbols(symbols: Vec<SymbolLocation>, fallback: &str) -> Vec<CodeNavLocation> {
    symbols
        .into_iter()
        .map(|location| symbol_location(location, Some(fallback.to_string())))
        .collect()
}

#[async_trait::async_trait]
impl CodeNavBackend for CodeNavIndexBackend {
    async fn goto_definition(
        &self,
        file: String,
        line: u32,
        column: u32,
    ) -> Result<Vec<CodeNavLocation>, String> {
        let result = self
            .handle()
            .goto_definition(self.resolve_file(&file), line as usize, column as usize)
            .await
            .map_err(|e| format!("index channel closed: {e}"))?
            .map_err(|e| format!("code nav query failed: {e:?}"))?;
        Ok(locations_from_query(result))
    }

    async fn goto_references(
        &self,
        file: String,
        line: u32,
        column: u32,
        include_definition: bool,
    ) -> Result<Vec<CodeNavLocation>, String> {
        let result = self
            .handle()
            .goto_references(
                self.resolve_file(&file),
                line as usize,
                column as usize,
                include_definition,
            )
            .await
            .map_err(|e| format!("index channel closed: {e}"))?
            .map_err(|e| format!("code nav query failed: {e:?}"))?;
        Ok(locations_from_query(result))
    }

    async fn find_definitions(
        &self,
        symbol: String,
        context_file: Option<String>,
    ) -> Result<Vec<CodeNavLocation>, String> {
        let result = self
            .handle()
            .find_definitions(
                symbol.clone(),
                context_file.as_deref().map(|f| self.resolve_file(f)),
            )
            .await
            .map_err(|e| format!("index channel closed: {e}"))?;
        Ok(locations_from_symbols(result, &symbol))
    }

    async fn find_references(
        &self,
        symbol: String,
        context_file: Option<String>,
    ) -> Result<Vec<CodeNavLocation>, String> {
        let result = self
            .handle()
            .find_references(
                symbol.clone(),
                context_file.as_deref().map(|f| self.resolve_file(f)),
            )
            .await
            .map_err(|e| format!("index channel closed: {e}"))?;
        Ok(locations_from_symbols(result, &symbol))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_system::CodebaseIndexManager;
    use std::time::Duration;

    /// A real index over a small repository answers definitions, references, and
    /// position lookups through the backend the model tool uses. Indexing runs in
    /// the background, so the queries are retried until the graph is warm.
    #[tokio::test]
    async fn real_index_answers_definitions_references_and_positions() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            tmp.path().join("lib.rs"),
            "pub fn handle(value: u32) -> u32 { value }\nfn call() -> u32 { handle(1) }\n",
        )
        .expect("write source");
        let backend = CodeNavIndexBackend::new(
            Arc::new(parking_lot::Mutex::new(CodebaseIndexManager::new())),
            tmp.path().to_path_buf(),
        );

        let (mut defs, mut refs, mut from_position) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..600 {
            defs = backend
                .find_definitions("handle".to_string(), None)
                .await
                .expect("definitions query");
            refs = backend
                .find_references("handle".to_string(), None)
                .await
                .expect("references query");
            from_position = backend
                .goto_definition("lib.rs".to_string(), 2, 20)
                .await
                .unwrap_or_default();
            if !defs.is_empty() && !refs.is_empty() && !from_position.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        assert!(
            defs.iter()
                .any(|l| l.path.ends_with("lib.rs") && l.line == 1),
            "definition missing: {defs:?}"
        );
        assert!(
            refs.iter().any(|l| l.line == 2),
            "reference at the call site missing: {refs:?}"
        );
        assert!(
            from_position.iter().any(|l| l.line == 1),
            "position lookup did not reach the definition: {from_position:?}"
        );

        // The manager caches the index under the grok home; drop this root's.
        let cache = crate::file_system::get_index_cache_path(backend.root());
        if let Some(dir) = cache.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
