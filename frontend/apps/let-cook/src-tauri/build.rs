fn main() {
    for path in [
        "tauri.conf.json",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }

    tauri_build::build()
}
