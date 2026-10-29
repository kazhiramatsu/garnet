//! The native tier of the regexp engine on the compiler's side (docs/regexp_vm_design.md "The
//! native tier"): the engine, linked into the analyzer by build.rs, writes the C of a literal's
//! matchers (runtime/regexp/rx_emit.c); the emitter pastes the text into the program and the
//! literal's sites pass the matchers to the adapter, which binds them to the pattern's program.
//! `TSAOT_REGEXP_NATIVE=0` emits no matchers (every pattern stays on the interpreter).
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::os::raw::{c_char, c_int};

extern "C" {
    fn rx_emit_native(src: *const u16, len: u32, flags: u32, id: u32, out: *mut *mut c_char) -> c_int;
    fn rx_free_text(s: *mut c_char);
}

#[derive(Default)]
struct Registry {
    /// (source, flags) -> the matcher id, None when the pattern does not compile
    ids: BTreeMap<(Vec<u16>, u32), Option<u32>>,
    /// the C of every matcher written so far
    texts: String,
    next: u32,
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }

pub fn enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_REGEXP_NATIVE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The start of a program's emission: the previous program's matchers are forgotten.
pub fn reset() {
    REGISTRY.with(|r| *r.borrow_mut() = Registry::default());
}

/// The id of the native matchers of a literal (its source as code units, its flag mask), written
/// on first sight: `rx_native_<id>_8` and `rx_native_<id>_16` in the program's C. None when the
/// tier is off or the pattern does not compile (the runtime throws the SyntaxError when the
/// literal is evaluated).
pub fn matcher_id(src: &[u16], flags: u32) -> Option<u32> {
    if !enabled() {
        return None;
    }
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let key = (src.to_vec(), flags);
        if let Some(id) = r.ids.get(&key) {
            return *id;
        }
        let id = r.next;
        let mut out: *mut c_char = std::ptr::null_mut();
        // SAFETY: the engine reads len units from src and writes a malloc'd C string to out.
        let rc = unsafe { rx_emit_native(src.as_ptr(), src.len() as u32, flags, id, &mut out) };
        let res = if rc == 0 && !out.is_null() {
            // SAFETY: out is a NUL-terminated string the engine allocated; freed right after the copy.
            let text = unsafe { std::ffi::CStr::from_ptr(out) }.to_string_lossy().into_owned();
            unsafe { rx_free_text(out) };
            r.texts.push_str(&text);
            r.next += 1;
            Some(id)
        } else {
            None
        };
        r.ids.insert(key, res);
        res
    })
}

/// The C of every matcher written since the reset (the program's native block), taken out.
pub fn take_texts() -> String {
    REGISTRY.with(|r| std::mem::take(&mut r.borrow_mut().texts))
}

/// The flag mask of a record line's letters (the adapter's `flags_text` order; the bits are the
/// engine's, which the adapter passes through).
fn flags_of(letters: &str) -> Option<u32> {
    let mut m = 0u32;
    for c in letters.chars() {
        m |= match c {
            'g' => 1,
            'i' => 2,
            'm' => 4,
            's' => 8,
            'u' => 16,
            'y' => 32,
            'd' => 64,
            'v' => 128,
            _ => return None,
        };
    }
    Some(m)
}

/// `tsaot regexps <record>`: the C of the native matchers of every distinct pattern in a training
/// run's record (`default.regexps`: `<flags>\t<hex UTF-16 units>\t<source>` lines, `#` comments;
/// docs/regexp_vm_design.md "The native tier for run-time patterns"), `static` in that unit, with
/// the table the engine looks patterns up in and a constructor that installs it. A line that does
/// not parse or a pattern that does not compile is skipped with a note on stderr. With the tier
/// off (`TSAOT_REGEXP_NATIVE=0`) or an empty record the text holds no table (the driver links
/// nothing).
pub fn emit_table(record: &str) -> String {
    let text = match std::fs::read_to_string(record) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("tsaot regexps: cannot read {}: {}", record, e);
            std::process::exit(1);
        }
    };
    let mut patterns: std::collections::BTreeSet<(u32, Vec<u16>)> = std::collections::BTreeSet::new();
    for (ln, line) in text.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut cols = line.split('\t');
        let (Some(fl), Some(hex)) = (cols.next(), cols.next()) else {
            eprintln!("tsaot regexps: {}:{}: not a pattern line (skipped)", record, ln + 1);
            continue;
        };
        let (Some(flags), true) = (flags_of(fl), hex.len() % 4 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit())) else {
            eprintln!("tsaot regexps: {}:{}: bad flags or units (skipped)", record, ln + 1);
            continue;
        };
        let units: Vec<u16> = (0..hex.len() / 4).map(|i| u16::from_str_radix(&hex[4 * i..4 * i + 4], 16).unwrap_or(0)).collect();
        patterns.insert((flags, units));
    }
    let mut out = String::new();
    out.push_str("/* garnet: the native matchers of the regular expressions a training run saw the program build at run\n   time (`tsaot regexps`, docs/regexp_vm_design.md \"The native tier for run-time patterns\"); the\n   constructor installs the table in the engine, which binds a pattern by content when it is compiled. */\n#include \"rx_native.h\"\n");
    if !enabled() {
        out.push_str("/* TSAOT_REGEXP_NATIVE=0: no matchers */\n");
        return out;
    }
    let mut entries: Vec<(u32, Vec<u16>, u32)> = Vec::new();
    for (flags, units) in &patterns {
        let id = entries.len() as u32;
        let mut text: *mut c_char = std::ptr::null_mut();
        // SAFETY: the engine reads units.len() units from units and writes a malloc'd C string to text.
        let rc = unsafe { rx_emit_native(units.as_ptr(), units.len() as u32, *flags, id, &mut text) };
        if rc != 0 || text.is_null() {
            eprintln!("tsaot regexps: a pattern of the record does not compile (skipped): {}", String::from_utf16_lossy(units));
            continue;
        }
        // SAFETY: text is a NUL-terminated string the engine allocated; freed right after the copy.
        let c = unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy().into_owned();
        unsafe { rx_free_text(text) };
        out.push_str(&c);
        entries.push((*flags, units.clone(), id));
    }
    if entries.is_empty() {
        out.push_str("/* no patterns */\n");
        return out;
    }
    for (_, units, id) in &entries {
        out.push_str(&format!("static const uint16_t rx_tbl_src_{}[{}] = {{", id, units.len().max(1)));
        if units.is_empty() {
            out.push_str("0");
        } else {
            out.push_str(&units.iter().map(|u| format!("0x{:04x}", u)).collect::<Vec<_>>().join(","));
        }
        out.push_str("};\n");
    }
    out.push_str("static const rx_native_table_entry rx_tbl[] = {\n");
    for (flags, units, id) in &entries {
        out.push_str(&format!("  {{ rx_tbl_src_{id}, {}u, {}u, rx_native_{id}_8, rx_native_{id}_16 }},\n", units.len(), flags, id = id));
    }
    out.push_str(&format!("}};\n__attribute__((constructor)) static void rx_tbl_install(void){{ rx_native_table_install(rx_tbl, {}u); }}\n", entries.len()));
    out
}
