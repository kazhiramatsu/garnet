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
