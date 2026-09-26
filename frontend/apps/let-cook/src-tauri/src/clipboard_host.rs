//! System clipboard write for the desktop shell (`clipboard_write`).

use std::io::Write;
use std::process::{Command, Stdio};

/// Write UTF-8 text to the OS clipboard.
///
/// Used when the webview's Async Clipboard API is denied (`NotAllowedError`).
pub fn write_text(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return write_via(&["pbcopy"], text);
    }

    #[cfg(target_os = "windows")]
    {
        return write_via(&["cmd", "/C", "clip"], text);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for spec in [
            &["wl-copy"][..],
            &["xclip", "-selection", "clipboard"][..],
            &["xsel", "--clipboard", "--input"][..],
        ] {
            if write_via(spec, text).is_ok() {
                return Ok(());
            }
        }
        return Err("no clipboard tool available (tried wl-copy, xclip, xsel)".to_string());
    }

    #[allow(unreachable_code)]
    Err("clipboard write is not supported on this platform".to_string())
}

fn write_via(argv: &[&str], text: &str) -> Result<(), String> {
    let (bin, args) = argv.split_first().ok_or("empty clipboard argv")?;
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("spawn {bin}: {error}"))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| format!("{bin} stdin"))?
        .write_all(text.as_bytes())
        .map_err(|error| format!("write {bin} stdin: {error}"))?;

    // Drop stdin so the tool sees EOF before wait.
    drop(child.stdin.take());

    let status = child
        .wait()
        .map_err(|error| format!("wait {bin}: {error}"))?;
    if !status.success() {
        return Err(format!("{bin} exited with {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn pbcopy_roundtrip() {
        super::write_text("let-cook-clipboard-probe").expect("pbcopy write");
        let out = std::process::Command::new("pbpaste")
            .output()
            .expect("pbpaste");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "let-cook-clipboard-probe");
    }

    #[test]
    fn empty_argv_is_rejected() {
        assert!(super::write_via(&[], "x").is_err());
    }
}
