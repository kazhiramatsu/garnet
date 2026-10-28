//! Links the regexp engine (runtime/regexp) into the analyzer for the native tier
//! (docs/regexp_vm_design.md "The native tier"): rx_native.rs calls the engine's emitter
//! through FFI to write the C of each regexp literal's matchers.
fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/regexp");
    cc::Build::new()
        .file(dir.join("rx_engine.c"))
        .file(dir.join("rx_emit.c"))
        .include(&dir)
        .opt_level(2)
        .warnings(false)
        .flag_if_supported("-std=c11")
        .compile("rxengine");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("runtime/regexp")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".c") || n.ends_with(".h"))
        .collect();
    names.sort();
    for n in names {
        println!("cargo:rerun-if-changed={}", dir.join(n).display());
    }
}
