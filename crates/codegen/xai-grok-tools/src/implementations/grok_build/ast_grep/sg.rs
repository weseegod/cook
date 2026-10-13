//! Resolves the ast-grep CLI that backs the `ast_grep` tool.
//!
//! Mirrors `grep/ripgrep.rs`: a release build embeds the binary and
//! self-extracts it on first use; other builds fall back to `ast-grep` on
//! `PATH`. The release's `sg` entry is a deprecated shim, so only `ast-grep`
//! is embedded and looked up.

use std::path::PathBuf;
use std::sync::OnceLock;
use xai_tool_runtime::{ToolError, ToolErrorKind};

#[cfg(bundle_sg)]
const SG_BYTES: &[u8] = include_bytes!(concat!(
    env!("OUT_DIR"),
    "/bundle-sg/ast-grep-",
    env!("GROK_TOOLS_SG_VER"),
    "-",
    env!("GROK_TOOLS_SG_TARGET"),
    ".bin.zst"
));

#[cfg(bundle_sg)]
fn resolve_bundled_sg() -> Result<Option<PathBuf>, crate::util::vendor::InstallError> {
    crate::util::vendor::resolve(
        concat!(
            "ast-grep-",
            env!("GROK_TOOLS_SG_VER"),
            "-",
            env!("GROK_TOOLS_SG_TARGET")
        ),
        SG_BYTES,
        env!("GROK_TOOLS_SG_SHA256"),
    )
}

/// Path to the ast-grep executable used by the `ast_grep` tool.
pub fn sg_path() -> Result<PathBuf, ToolError> {
    static SG_EXEC: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    SG_EXEC
        .get_or_init(|| {
            #[cfg(bundle_sg)]
            {
                resolve_bundled_sg()
                    .map(|found| found.unwrap_or_else(|| PathBuf::from("ast-grep")))
                    .map_err(|e| e.to_string())
            }
            #[cfg(not(bundle_sg))]
            {
                Ok(PathBuf::from("ast-grep"))
            }
        })
        .clone()
        .map_err(|msg| ToolError::new(ToolErrorKind::Execution, msg))
}
