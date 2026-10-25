//! The emitter's unit mode (docs/build_split_design.md): the one-file C,
//! split into a shared header, a data unit, a cold unit compiled at -O0 and
//! function units grouped by source module, so a native build compiles
//! them in parallel and recompiles only the units an edit changed.
//!
//! The split works on the emitted text, whose top level the emitter keeps
//! regular: preprocessor lines, typedefs and structs, `static` prototypes,
//! function definitions and `static` data with their initializers. A
//! lexer that skips string and character literals and comments finds the
//! top-level items; an item it cannot classify stops the split (loud).
//!
//! Two measures keep the one-file build's inlining (measured in the design
//! document): a small function another unit calls gets a `static inline`
//! copy `<name>__i` in each unit that calls it, and those calls use the copy
//! (its own unit keeps the one external definition, so its address stays
//! unique); and a function referenced only inside its own unit stays
//! `static`. The copies live in the units that use them, not in the shared
//! header, so editing a copied function recompiles only its callers' units.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

pub struct Options {
    /// Largest function (lines) that gets a header copy for calls from other units.
    pub inline_lines: usize,
    /// A module larger than this (lines) is split into chunks of about this size.
    pub chunk_lines: usize,
    /// Smaller modules are distributed over this many units by a hash of their path.
    pub bins: usize,
    /// Functions at least this large (lines) are cold: compiled at -O0.
    pub cold_lines: usize,
    /// A cold function of the module initialization's shape is split into
    /// optimized chunks (docs/startup_design.md, S1); TSAOT_UNIT_SPLIT_INIT=0 keeps it whole.
    pub split_init: bool,
    /// Lines per chunk of a split module initialization.
    pub init_chunk_lines: usize,
}

impl Options {
    pub fn from_env() -> Options {
        let get = |k: &str, d: usize| -> usize {
            std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
        };
        Options {
            inline_lines: get("TSAOT_UNIT_INLINE_LINES", 60),
            chunk_lines: get("TSAOT_UNIT_CHUNK_LINES", 20000),
            bins: get("TSAOT_UNIT_BINS", 16).max(1),
            cold_lines: get("TSAOT_UNIT_COLD_LINES", 10000),
            split_init: get("TSAOT_UNIT_SPLIT_INIT", 1) != 0,
            init_chunk_lines: get("TSAOT_UNIT_INIT_CHUNK_LINES", 1000).max(1),
        }
    }
}

enum Item {
    Header(String),
    Proto { name: String, text: String },
    Func { name: String, sig: String, body: String, lines: usize },
    Data { decl: String, defn: String },
}

/// Lexer state for C text: skips string/char literals and comments.
#[derive(Clone, Copy, PartialEq)]
enum Lx {
    Code,
    Str,
    Chr,
    LineComment,
    BlockComment,
}

/// Split the text into top-level items (line-aligned).
fn top_level_items(c: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut depth: i64 = 0;
    let mut st = Lx::Code;
    for line in c.split_inclusive('\n') {
        let starts_item = depth == 0 && st == Lx::Code && cur.is_empty();
        if starts_item {
            let t = line.trim_start();
            let tt = t.trim_end();
            if t.starts_with('#')
                || tt.is_empty()
                || t.starts_with("//")
                || (t.starts_with("/*") && tt.ends_with("*/") && !tt[2..tt.len() - 2].contains("*/"))
            {
                items.push(line.to_string());
                continue;
            }
        }
        cur.push_str(line);
        // advance the lexer over this line
        let b = line.as_bytes();
        let mut i = 0;
        let mut last_sig: u8 = b' ';
        while i < b.len() {
            let ch = b[i];
            match st {
                Lx::Code => match ch {
                    b'"' => st = Lx::Str,
                    b'\'' => st = Lx::Chr,
                    b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                        st = Lx::LineComment;
                        i += 1;
                    }
                    b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                        st = Lx::BlockComment;
                        i += 1;
                    }
                    b'{' => {
                        depth += 1;
                        last_sig = ch;
                    }
                    b'}' => {
                        depth -= 1;
                        last_sig = ch;
                    }
                    b' ' | b'\t' | b'\n' | b'\r' => {}
                    _ => last_sig = ch,
                },
                Lx::Str => {
                    if ch == b'\\' {
                        i += 1;
                    } else if ch == b'"' {
                        st = Lx::Code;
                        last_sig = ch;
                    }
                }
                Lx::Chr => {
                    if ch == b'\\' {
                        i += 1;
                    } else if ch == b'\'' {
                        st = Lx::Code;
                        last_sig = ch;
                    }
                }
                Lx::LineComment => {
                    if ch == b'\n' {
                        st = Lx::Code;
                    }
                }
                Lx::BlockComment => {
                    if ch == b'*' && i + 1 < b.len() && b[i + 1] == b'/' {
                        st = Lx::Code;
                        i += 1;
                    }
                }
            }
            i += 1;
        }
        if st == Lx::LineComment {
            st = Lx::Code;
        }
        if depth == 0 && st == Lx::Code && (last_sig == b';' || last_sig == b'}') {
            items.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        items.push(cur);
    }
    items
}

/// Identifier tokens outside literals and comments, with their byte ranges.
fn identifiers(text: &str) -> Vec<(usize, usize)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut st = Lx::Code;
    let mut i = 0;
    while i < b.len() {
        let ch = b[i];
        match st {
            Lx::Code => {
                if ch == b'"' {
                    st = Lx::Str;
                } else if ch == b'\'' {
                    st = Lx::Chr;
                } else if ch == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
                    st = Lx::LineComment;
                    i += 1;
                } else if ch == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
                    st = Lx::BlockComment;
                    i += 1;
                } else if ch.is_ascii_alphabetic() || ch == b'_' {
                    let s = i;
                    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                        i += 1;
                    }
                    out.push((s, i));
                    continue;
                } else if ch.is_ascii_digit() {
                    // a number (with suffixes such as 1u, 0x1F, 1.5e3)
                    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.') {
                        i += 1;
                    }
                    continue;
                }
            }
            Lx::Str => {
                if ch == b'\\' {
                    i += 1;
                } else if ch == b'"' {
                    st = Lx::Code;
                }
            }
            Lx::Chr => {
                if ch == b'\\' {
                    i += 1;
                } else if ch == b'\'' {
                    st = Lx::Code;
                }
            }
            Lx::LineComment => {
                if ch == b'\n' {
                    st = Lx::Code;
                }
            }
            Lx::BlockComment => {
                if ch == b'*' && i + 1 < b.len() && b[i + 1] == b'/' {
                    st = Lx::Code;
                    i += 1;
                }
            }
        }
        i += 1;
    }
    out
}

/// The byte index just past the first `{` that opens the function body:
/// the first `{` after the parameter list's closing parenthesis.
fn body_start(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 0i64;
    let mut seen_paren = false;
    for (i, &ch) in b.iter().enumerate() {
        match ch {
            b'(' => {
                depth += 1;
                seen_paren = true;
            }
            b')' => depth -= 1,
            b'{' if depth == 0 && seen_paren => return Some(i),
            b';' if depth == 0 => return None,
            b'=' if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

/// The name of the function a definition or prototype declares: the
/// identifier right before the parameter list's opening parenthesis.
fn declared_name(text: &str) -> Option<String> {
    let k = text.find('(')?;
    let head = text[..k].trim_end();
    let start = head
        .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .map(|p| p + 1)
        .unwrap_or(0);
    let name = &head[start..];
    if name.is_empty() || name.chars().next().unwrap().is_ascii_digit() {
        None
    } else {
        Some(name.to_string())
    }
}

/// The byte index of the first `=` at bracket depth 0 (a data initializer).
fn top_level_eq(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 0i64;
    for (i, &ch) in b.iter().enumerate() {
        match ch {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b'=' if depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

fn classify(text: String) -> Result<Item, String> {
    let t = text.trim_start();
    if t.is_empty()
        || t.starts_with('#')
        || t.starts_with("/*")
        || t.starts_with("//")
        || t.starts_with("typedef")
        || t.starts_with("struct ")
        || t.starts_with("union ")
        || t.starts_with("enum ")
        || t.starts_with("TS_AOT_INLINE")
        || t.starts_with("TS_AOT_HINT")
    {
        return Ok(Item::Header(text));
    }
    if let Some(k) = body_start(t) {
        let name = declared_name(&t[..k]).ok_or_else(|| format!("no function name: {}", first_line(t)))?;
        // the body keeps the whitespace before its brace: sig + body is the original text
        let head = t[..k].trim_end();
        let sig = head.strip_prefix("static ").unwrap_or(head).to_string();
        let body = t[head.len()..].to_string();
        let lines = t.matches('\n').count().max(1);
        return Ok(Item::Func { name, sig, body, lines });
    }
    if t.starts_with("static ") {
        let trimmed = t.trim_end();
        if trimmed.ends_with(");") && top_level_eq(trimmed).is_none() && trimmed.contains('(') {
            let name = declared_name(trimmed).ok_or_else(|| format!("no prototype name: {}", first_line(t)))?;
            return Ok(Item::Proto { name, text });
        }
        if let Some(rest) = trimmed.strip_prefix("static struct {") {
            // an anonymous struct object (the string literals): give the type a name
            let close = matching_brace(rest).ok_or_else(|| format!("unbalanced struct: {}", first_line(t)))?;
            let fields = &rest[..close];
            let after = rest[close + 1..].trim_start();
            let eq = after.find('=').ok_or_else(|| format!("struct object without initializer: {}", first_line(t)))?;
            let name = after[..eq].trim().to_string();
            let init = after[eq..].to_string();
            return Ok(Item::Data {
                decl: format!("struct {name}__t {{{fields}}};\nextern struct {name}__t {name};\n"),
                defn: format!("struct {name}__t {name} {init}\n"),
            });
        }
        // `static T NAME[DIMS] = INIT;` or `static T NAME;`
        let decl_end = top_level_eq(trimmed).unwrap_or(trimmed.len() - 1);
        let declarator = trimmed[..decl_end].trim_end();
        let declarator = declarator.strip_prefix("static ").unwrap_or(declarator);
        if declarator.contains('(') {
            return Err(format!("unsupported declarator: {}", first_line(t)));
        }
        return Ok(Item::Data {
            decl: format!("extern {};\n", declarator),
            defn: format!("{}\n", trimmed.strip_prefix("static ").unwrap_or(trimmed)),
        });
    }
    Err(format!("unclassified top-level item: {}", first_line(t)))
}

fn first_line(t: &str) -> &str {
    let l = t.lines().next().unwrap_or("");
    &l[..l.len().min(160)]
}

/// The index of the `}` that closes the brace block starting before `s`.
fn matching_brace(s: &str) -> Option<usize> {
    let mut depth = 1i64;
    for (i, ch) in s.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

fn module_of(name: &str, fn_module: &BTreeMap<u32, u32>) -> Option<u32> {
    let rest = name.strip_prefix("fn_")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let id: u32 = digits.parse().ok()?;
    fn_module.get(&id).copied()
}

/// Rewrite the calls to the functions `copied` selects into calls to their
/// copies; returns the text and the functions whose copies it calls.
fn rewrite_calls(body: &str, copied: impl Fn(&str) -> bool) -> (String, BTreeSet<String>) {
    let b = body.as_bytes();
    let mut out = String::with_capacity(body.len() + 64);
    let mut used = BTreeSet::new();
    let mut last = 0;
    for (s, e) in identifiers(body) {
        let id = &body[s..e];
        if copied(id) {
            let mut j = e;
            while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
                j += 1;
            }
            if j < b.len() && b[j] == b'(' {
                out.push_str(&body[last..e]);
                out.push_str("__i");
                last = e;
                used.insert(id.to_string());
            }
        }
    }
    out.push_str(&body[last..]);
    (out, used)
}

/// A `TS_AOT_HINT` function whose body has local statics (inline-cache cells)
/// cannot be a header function, as every unit would get cells of its own: it
/// and its prototype become an ordinary unit function, the hint dropped.
fn demote_hinted_with_statics(items: Vec<Item>) -> Result<Vec<Item>, String> {
    let hinted_name = |text: &str| -> Option<String> {
        let t = text.trim_start();
        if !t.starts_with("TS_AOT_HINT") {
            return None;
        }
        let k = body_start(t).unwrap_or(t.len());
        declared_name(&t[..k])
    };
    let mut demote: HashSet<String> = HashSet::new();
    for it in &items {
        if let Item::Header(text) = it {
            let t = text.trim_start();
            if t.starts_with("TS_AOT_HINT") && body_start(t).is_some() && has_local_static(t) {
                if let Some(name) = hinted_name(text) {
                    demote.insert(name);
                }
            }
        }
    }
    if demote.is_empty() {
        return Ok(items);
    }
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        match it {
            Item::Header(text) => match hinted_name(&text) {
                Some(name) if demote.contains(&name) => {
                    let plain = text.trim_start().replacen("TS_AOT_HINT", "static", 1);
                    out.push(classify(plain)?);
                }
                _ => out.push(Item::Header(text)),
            },
            other => out.push(other),
        }
    }
    Ok(out)
}

fn has_local_static(body: &str) -> bool {
    // TS_ISO_IC: the threads accessor experiment keeps the plain build's copies
    identifiers(body).iter().any(|&(s, e)| &body[s..e] == "static" || &body[s..e] == "TS_ISO_IC")
}

// ---- The module initialization split (docs/startup_design.md, S1) ----
//
// The exporter puts every module's top-level code into one function, which
// the emitter writes as one C function: tens of thousands of variables and
// over a hundred thousand lines, too large to optimize, so it was a cold unit
// compiled at -O0. A function of its shape is cut at top-level statement
// boundaries into chunk functions an ordinary unit compiles with
// optimization. A variable one chunk uses becomes that chunk's own; one
// several chunks use lives in a struct on the caller's stack (`mi__s->`), as
// does the frame (`mi__f->`). Anything unexpected keeps the function whole.

/// Brace depth after each line, and whether the line ends inside parentheses,
/// brackets or a block comment (literals and comments skipped; a literal never
/// spans lines here).
fn line_depths(lines: &[&str]) -> Vec<(i64, bool)> {
    let mut out = Vec::with_capacity(lines.len());
    let mut depth = 0i64;
    let mut paren = 0i64;
    let mut st = Lx::Code;
    for line in lines {
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            let ch = b[i];
            match st {
                Lx::Code => match ch {
                    b'"' => st = Lx::Str,
                    b'\'' => st = Lx::Chr,
                    b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                        st = Lx::LineComment;
                        i += 1;
                    }
                    b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                        st = Lx::BlockComment;
                        i += 1;
                    }
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    b'(' | b'[' => paren += 1,
                    b')' | b']' => paren -= 1,
                    _ => {}
                },
                Lx::Str => {
                    if ch == b'\\' {
                        i += 1;
                    } else if ch == b'"' {
                        st = Lx::Code;
                    }
                }
                Lx::Chr => {
                    if ch == b'\\' {
                        i += 1;
                    } else if ch == b'\'' {
                        st = Lx::Code;
                    }
                }
                Lx::LineComment => {}
                Lx::BlockComment => {
                    if ch == b'*' && i + 1 < b.len() && b[i + 1] == b'/' {
                        st = Lx::Code;
                        i += 1;
                    }
                }
            }
            i += 1;
        }
        if st != Lx::BlockComment {
            st = Lx::Code;
        }
        out.push((depth, st == Lx::BlockComment || paren != 0));
    }
    out
}

const C_STMT_KEYWORDS: &[&str] = &[
    "return", "goto", "if", "else", "while", "for", "do", "switch", "case", "default", "break",
    "continue", "sizeof",
];

/// A statement at the function's top level, as the split sees it.
#[derive(Debug, PartialEq)]
enum TopStmt {
    /// `TYPE NAME;` or `TYPE NAME = INIT;`
    Plain { ty: String, name: String, init: Option<String> },
    /// Another declaration (several declarators or statements on the line,
    /// statics, an array): the names it declares, kept in one chunk with their
    /// uses; `automatic_array` when one is an array that is not static (it
    /// decays to a pointer a later chunk may hold, so the function stays whole).
    Pinned { names: Vec<(String, bool)>, automatic_array: bool },   // (name, static)
    /// An expression or a control statement.
    Other,
    /// What the split does not handle at the top level (a type, a nested
    /// function declaration): the function stays whole.
    Unsupported,
}

/// The byte offsets of the top-level `;` of a statement line (outside
/// parentheses, brackets, braces and literals).
fn top_level_semis(t: &str) -> Vec<usize> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i64;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => out.push(i),
            _ => {}
        }
        i += 1;
    }
    out
}

/// The first top-level `=` that is an assignment (not `==`, `<=`, `>=`, `!=`).
fn top_level_assign(t: &str) -> Option<usize> {
    let b = t.as_bytes();
    let mut depth = 0i64;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b'=' if depth == 0 => {
                let prev = if i > 0 { b[i - 1] } else { b' ' };
                let next = if i + 1 < b.len() { b[i + 1] } else { b' ' };
                if next != b'=' && !matches!(prev, b'=' | b'<' | b'>' | b'!') {
                    return Some(i);
                }
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Whether the text has a `,` outside parentheses, brackets, braces and literals.
fn has_top_level_comma(t: &str) -> bool {
    let b = t.as_bytes();
    let mut depth = 0i64;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

/// The names a declaration declares: per top-level declarator, the last
/// identifier before its initializer and array dimensions.
fn declared_names(decl: &str) -> Vec<String> {
    let mut parts: Vec<&str> = Vec::new();
    let b = decl.as_bytes();
    let (mut depth, mut start, mut i) = (0i64, 0usize, 0usize);
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&decl[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&decl[start..]);
    let mut names = Vec::new();
    for p in parts {
        let p = match top_level_assign(p) {
            Some(k) => &p[..k],
            None => p,
        };
        let p = match p.find('[') {
            Some(k) => &p[..k],
            None => p,
        };
        if let Some(&(s, e)) = identifiers(p).last() {
            names.push(p[s..e].to_string());
        }
    }
    names
}

/// Whether a declaration declares an array: a `[` in a declarator before its
/// initializer.
fn decl_has_array(decl: &str) -> bool {
    let b = decl.as_bytes();
    let (mut depth, mut start, mut i) = (0i64, 0usize, 0usize);
    let mut parts: Vec<&str> = Vec::new();
    while i < b.len() {
        match b[i] {
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'(' | b'{' => depth += 1,
            b')' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&decl[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&decl[start..]);
    parts.iter().any(|p| {
        let head = match top_level_assign(p) {
            Some(k) => &p[..k],
            None => p,
        };
        head.contains('[')
    })
}

/// Classify a line at the function's top level.
fn top_stmt(line: &str) -> TopStmt {
    let t = line.trim();
    if t.is_empty() {
        return TopStmt::Other;
    }
    let semis = top_level_semis(t);
    if semis.len() <= 1 && t[semis.first().map_or(t.len(), |&k| k + 1)..].trim().is_empty() {
        return one_stmt(t);
    }
    // several statements on the line (a literal's layout and its keys, a
    // modulo's two operands and the test that follows): what they declare is
    // pinned
    let mut names = Vec::new();
    let mut automatic_array = false;
    let mut from = 0;
    let mut pieces: Vec<&str> = Vec::new();
    for &k in &semis {
        pieces.push(t[from..=k].trim());
        from = k + 1;
    }
    let rest = t[from..].trim();
    if !rest.is_empty() {
        pieces.push(rest);
    }
    for piece in pieces {
        match one_stmt(piece) {
            TopStmt::Plain { name, .. } => names.push((name, false)),
            TopStmt::Pinned { names: n, automatic_array: a } => {
                names.extend(n);
                automatic_array |= a;
            }
            TopStmt::Unsupported => return TopStmt::Unsupported,
            TopStmt::Other => {}
        }
    }
    if names.is_empty() {
        TopStmt::Other
    } else {
        TopStmt::Pinned { names, automatic_array }
    }
}

/// Classify one statement of a top-level line.
fn one_stmt(t: &str) -> TopStmt {
    let t = t.trim();
    if t.is_empty() {
        return TopStmt::Other;
    }
    let semis = top_level_semis(t);
    let first_word: String = t.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    if t.starts_with("static ") {
        // a static's storage outlives every chunk
        let decl = t.strip_suffix(';').unwrap_or(t);
        return TopStmt::Pinned { names: declared_names(decl).into_iter().map(|n| (n, true)).collect(), automatic_array: false };
    }
    if matches!(first_word.as_str(), "typedef" | "struct" | "union" | "enum" | "extern" | "register" | "auto" | "_Thread_local")
    {
        return TopStmt::Unsupported;
    }
    if first_word.is_empty() || C_STMT_KEYWORDS.contains(&first_word.as_str()) {
        return TopStmt::Other;
    }
    // TYPE NAME…: a run of identifiers and `*` ending in the declared name
    let b = t.as_bytes();
    let mut i = first_word.len();
    let mut tokens: Vec<(usize, usize)> = vec![(0, first_word.len())];
    loop {
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
        if i < b.len() && b[i] == b'*' {
            i += 1;
            continue;
        }
        if i < b.len() && (b[i].is_ascii_alphabetic() || b[i] == b'_') {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            tokens.push((s, i));
            continue;
        }
        break;
    }
    if tokens.len() < 2 {
        return TopStmt::Other; // `name = …`, `f(…)`, `name->f = …`, a label
    }
    let term = if i < b.len() { b[i] } else { b';' };
    // `a * b;` or `x *= y` would read as declarations only in code the emitter does not write
    match term {
        b'=' | b';' => {}
        b'[' | b',' => {
            if !(semis.len() == 1 && semis[0] == t.len() - 1) {
                return TopStmt::Unsupported;
            }
            let decl = &t[..t.len() - 1];
            // an array among the declarators (before each one's initializer)
            let array = decl_has_array(decl);
            return TopStmt::Pinned { names: declared_names(decl).into_iter().map(|n| (n, false)).collect(), automatic_array: array };
        }
        b'(' => return TopStmt::Unsupported, // a declaration of a function, or a macro this split does not know
        _ => return TopStmt::Other,
    }
    if semis.len() != 1 || semis[0] != t.len() - 1 {
        return TopStmt::Unsupported; // top_stmt splits the statements first
    }
    let body = &t[..t.len() - 1];
    if has_top_level_comma(body) {
        return TopStmt::Pinned { names: declared_names(body).into_iter().map(|n| (n, false)).collect(), automatic_array: decl_has_array(body) };
    }
    let (ns, ne) = *tokens.last().unwrap();
    let name = t[ns..ne].to_string();
    let ty = t[..ns].trim_end().to_string();
    let init = if term == b'=' { Some(body[i + 1..].trim().to_string()) } else { None };
    TopStmt::Plain { ty, name, init }
}

/// Rewrite one line of a chunk: the shared variables through `mi__s->`, the
/// frame through `mi__f->` (not after `.` or `->`, not in literals or comments).
fn rewrite_chunk_line(line: &str, shared: &HashSet<String>) -> String {
    let mut out = String::with_capacity(line.len() + 16);
    let mut last = 0;
    let b = line.as_bytes();
    for (s, e) in identifiers(line) {
        let id = &line[s..e];
        let mut p = s;
        while p > 0 && (b[p - 1] == b' ' || b[p - 1] == b'\t') {
            p -= 1;
        }
        let member = p > 0 && (b[p - 1] == b'.' || (p > 1 && b[p - 1] == b'>' && b[p - 2] == b'-'));
        if member {
            continue;
        }
        if id == "F" && e < b.len() && b[e] == b'.' {
            out.push_str(&line[last..s]);
            out.push_str("mi__f->");
            last = e + 1;
        } else if shared.contains(id) {
            out.push_str(&line[last..s]);
            out.push_str("mi__s->");
            out.push_str(id);
            last = e;
        }
    }
    out.push_str(&line[last..]);
    out
}

/// A split function: the caller, its chunks in order, and each chunk's unit index.
struct InitSplit {
    caller_body: String,
    parts: Vec<(String, String, usize)>, // (name, body, lines)
    typedefs: String,
}

/// Split a function of the module initialization's shape (docs/startup_design.md,
/// S1); `None` keeps it whole.
fn split_init_function(name: &str, sig: &str, body: &str, chunk_lines: usize) -> Option<InitSplit> {
    if sig.trim() != format!("tsv {}(void)", name) {
        return None;
    }
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() < 8 || lines[0].trim() != "{" || lines[lines.len() - 1].trim() != "}" {
        return None;
    }
    // the prologue: plain declarations with constant initializers (they move
    // to the chunk that uses them, so no side effect may move with them)
    let const_init = |init: &Option<String>| -> bool {
        let Some(t) = init else { return true };
        let t = t.trim();
        let num = t.strip_prefix('-').unwrap_or(t);
        (!num.is_empty()
            && num.as_bytes()[0].is_ascii_digit()
            && num.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.'))
            || matches!(t, "TS_UNDEFINED" | "TS_NULL" | "TS_TRUE" | "TS_FALSE" | "NULL")
    };
    let mut pro: Vec<(String, String, Option<String>, &str)> = Vec::new(); // (type, name, init, line)
    let mut k = 1;
    while k < lines.len() - 1 {
        match top_stmt(lines[k]) {
            TopStmt::Plain { ty, name, init } if const_init(&init) => pro.push((ty, name, init, lines[k])),
            _ => break,
        }
        k += 1;
    }
    // the frame, when the function has one (its slots' initializations, its push)
    let framed = lines[k].trim().starts_with("struct { ts_frame_hdr h;") && lines[k].trim().ends_with("} F;");
    let (frame_members, frame_inits, push_line, body_start) = if framed {
        let fr = k;
        let push = (fr + 1..lines.len()).find(|&i| lines[i].trim().starts_with("ts_frame_push(&F.h,"))?;
        for l in &lines[fr + 1..push] {
            if !l.trim().starts_with("F.") {
                return None;
            }
        }
        let ft = lines[fr].trim();
        (ft["struct {".len()..ft.len() - "} F;".len()].trim().to_string(), lines[fr + 1..push].to_vec(), lines[push], push + 1)
    } else {
        (String::new(), Vec::new(), "", k)
    };
    // the epilogue: the pops and returns at the end
    let close = lines.len() - 1;
    let mut epi = close;
    while epi > body_start && matches!(lines[epi - 1].trim(), "ts_frame_pop(&F.h);" | "return TS_UNDEFINED;") {
        epi -= 1;
    }
    let first = if framed { "ts_frame_pop(&F.h);" } else { "return TS_UNDEFINED;" };
    if epi == close || lines[epi].trim() != first || epi <= body_start {
        return None;
    }
    let body_lines: Vec<&str> = lines[body_start..epi].to_vec();
    let n = body_lines.len();
    let dep = line_depths(&body_lines);
    if dep.last().map_or(true, |d| d.0 != 0 || d.1) {
        return None;
    }
    // what the split does not move between functions
    let mut fscope: HashMap<String, usize> = HashMap::new(); // function-scope name -> prologue index or usize::MAX
    for (k, p) in pro.iter().enumerate() {
        fscope.insert(p.1.clone(), k);
    }
    for (_, _, init, _) in &pro {
        if let Some(init) = init {
            for (s, e) in identifiers(init) {
                let id = &init[s..e];
                if id == "F" || fscope.contains_key(id) {
                    return None;
                }
            }
        }
    }
    let mut mid_plain: HashMap<String, (usize, String, Option<String>)> = HashMap::new(); // name -> (line, type, init)
    let mut pinned: Vec<(String, usize)> = Vec::new(); // (name, declaring line)
    let mut pinned_static: HashSet<String> = HashSet::new();
    let mut tokens_of: Vec<Vec<(usize, usize)>> = Vec::with_capacity(n);
    for (i, l) in body_lines.iter().enumerate() {
        let toks = identifiers(l);
        let lb = l.as_bytes();
        let tl = l.trim_start();
        if tl.starts_with('#') {
            return None;
        }
        for &(s, e) in &toks {
            let id = &l[s..e];
            if id.starts_with("mi__")
                || matches!(id, "return" | "setjmp" | "_setjmp" | "sigsetjmp" | "ts_setjmp" | "ts_eh_push" | "__label__")
            {
                return None;
            }
            if id == "F" && (!framed || !(e < lb.len() && lb[e] == b'.')) {
                return None;
            }
            if id == "goto" {
                let mut j = e;
                while j < lb.len() && lb[j] == b' ' {
                    j += 1;
                }
                if j < lb.len() && lb[j] == b'*' {
                    return None; // a computed goto
                }
            }
        }
        let top = i == 0 || dep[i - 1].0 == 0;
        if top && !(i > 0 && dep[i - 1].1) {
            match top_stmt(l) {
                TopStmt::Plain { ty, name, init } => {
                    if fscope.contains_key(&name) {
                        return None;
                    }
                    fscope.insert(name.clone(), usize::MAX);
                    mid_plain.insert(name, (i, ty, init));
                }
                TopStmt::Pinned { names, automatic_array } => {
                    // an automatic array may be reached through a pointer from a
                    // later chunk (it decays); a static's storage outlives them all
                    if automatic_array {
                        return None;
                    }
                    for (nm, is_static) in names {
                        if fscope.contains_key(&nm) {
                            return None;
                        }
                        fscope.insert(nm.clone(), usize::MAX);
                        if is_static {
                            pinned_static.insert(nm.clone());
                        }
                        pinned.push((nm, i));
                    }
                }
                TopStmt::Unsupported => return None,
                TopStmt::Other => {}
            }
        }
        tokens_of.push(toks);
    }
    // a nested declaration of a function-scope name keeps the function whole:
    // the name after a run of type words (identifiers and `*`) that starts a
    // statement (the line's start, `{`, `;` or `(`) and before `=`, `;`, `,` or `[`
    for (i, l) in body_lines.iter().enumerate() {
        if i == 0 || dep[i - 1].0 == 0 {
            continue;
        }
        let lb = l.as_bytes();
        let toks = &tokens_of[i];
        for (k, &(s, e)) in toks.iter().enumerate() {
            if k == 0 || !fscope.contains_key(&l[s..e]) {
                continue;
            }
            let mut j = e;
            while j < lb.len() && (lb[j] == b' ' || lb[j] == b'\t') {
                j += 1;
            }
            if !(j >= lb.len() || matches!(lb[j], b'=' | b';' | b',' | b'[')) || (lb.get(j) == Some(&b'=') && lb.get(j + 1) == Some(&b'=')) {
                continue;
            }
            // walk back over the type words
            let mut m = k;
            let mut words = 0;
            while m > 0 {
                let (ps, pe) = toks[m - 1];
                let gap = &l[pe..toks[m].0];
                if !gap.chars().all(|c| c == ' ' || c == '\t' || c == '*') || C_STMT_KEYWORDS.contains(&&l[ps..pe]) {
                    break;
                }
                m -= 1;
                words += 1;
            }
            if words == 0 {
                continue;
            }
            let start = toks[m].0;
            let before = l[..start].trim_end();
            if before.is_empty() || before.ends_with('{') || before.ends_with(';') || before.ends_with('(') {
                return None;
            }
        }
    }
    // spans no cut may enter: a label with its gotos, a pinned name with its uses
    let mut occurrences: HashMap<&str, (usize, usize)> = HashMap::new();
    for (i, l) in body_lines.iter().enumerate() {
        for &(s, e) in &tokens_of[i] {
            let id = &l[s..e];
            if fscope.contains_key(id) {
                let ent = occurrences.entry(id).or_insert((i, i));
                ent.1 = i;
            }
        }
    }
    let mut block = vec![0i32; n + 1];
    let span = |lo: usize, hi: usize, block: &mut Vec<i32>| {
        if lo < hi {
            block[lo] += 1;
            block[hi] -= 1;
        }
    };
    let mut labels: HashMap<String, (usize, usize)> = HashMap::new();
    for (i, l) in body_lines.iter().enumerate() {
        let toks = &tokens_of[i];
        if toks.len() == 1 && l[..toks[0].0].trim().is_empty() && {
            let rest = l[toks[0].1..].trim();
            rest == ":" || rest == ": ;" || rest == ":;"
        } {
            let nm = l[toks[0].0..toks[0].1].to_string();
            if nm != "default" {
                let ent = labels.entry(nm).or_insert((i, i));
                ent.0 = ent.0.min(i);
                ent.1 = ent.1.max(i);
            }
        }
        for k in 0..toks.len() {
            if &l[toks[k].0..toks[k].1] == "goto" && k + 1 < toks.len() {
                let nm = l[toks[k + 1].0..toks[k + 1].1].to_string();
                let ent = labels.entry(nm).or_insert((i, i));
                ent.0 = ent.0.min(i);
                ent.1 = ent.1.max(i);
            }
        }
    }
    for (_, &(lo, hi)) in &labels {
        span(lo, hi, &mut block);
    }
    for (nm, _) in &pinned {
        if let Some(&(lo, hi)) = occurrences.get(nm.as_str()) {
            span(lo, hi, &mut block);
        }
    }
    let mut blocked = vec![false; n];
    let mut run = 0i32;
    for i in 0..n {
        run += block[i];
        blocked[i] = run > 0; // a cut after line i would split a span that covers it
    }
    // the cuts: after a complete top-level statement, every chunk_lines lines
    let mut cuts: Vec<usize> = vec![0];
    let mut last = 0usize;
    for i in 0..n.saturating_sub(1) {
        if dep[i].0 != 0 || dep[i].1 || blocked[i] || i + 1 - last < chunk_lines {
            continue;
        }
        let mut s = body_lines[i].trim_end();
        if s.ends_with("*/") {
            // a trailing comment (`/* site 12 PretenuredHeap */`)
            if let Some(k) = s.rfind("/*") {
                s = s[..k].trim_end();
            }
        }
        if !(s.ends_with(';') || s.ends_with('}')) {
            continue;
        }
        let nxt = body_lines[i + 1].trim_start();
        if nxt.starts_with("else") || nxt.starts_with("while") || nxt.starts_with('}') {
            continue;
        }
        cuts.push(i + 1);
        last = i + 1;
    }
    cuts.push(n);
    if cuts.len() < 3 {
        return None; // one chunk: nothing to gain
    }
    let chunk_of = |line: usize| -> usize { cuts.partition_point(|&c| c <= line) - 1 };
    // which chunks use each function-scope variable
    let mut users: HashMap<&str, BTreeSet<usize>> = HashMap::new();
    for (i, l) in body_lines.iter().enumerate() {
        let c = chunk_of(i);
        for &(s, e) in &tokens_of[i] {
            let id = &l[s..e];
            if fscope.contains_key(id) {
                users.entry(id).or_default().insert(c);
            }
        }
    }
    for (nm, _) in &pinned {
        if users.get(nm.as_str()).map_or(false, |u| u.len() > 1) {
            return None; // the spans above keep them in one chunk; never reached
        }
    }
    // a variable whose address is taken, or of a struct type (an object the
    // escape analysis put on the stack, whose address a value holds), lives on
    // the caller's stack whatever its users: a pointer to it may outlive the
    // chunk that made it (a frame slot, a root, another object)
    let mut addressed: HashSet<&str> = HashSet::new();
    for (i, l) in body_lines.iter().enumerate() {
        let lb = l.as_bytes();
        for &(s, e) in &tokens_of[i] {
            let mut p = s;
            while p > 0 && (lb[p - 1] == b' ' || lb[p - 1] == b'\t' || lb[p - 1] == b'(') {
                p -= 1;
            }
            if p > 0 && lb[p - 1] == b'&' && !(p > 1 && lb[p - 2] == b'&') && fscope.contains_key(&l[s..e]) {
                addressed.insert(&l[s..e]);
            }
        }
    }
    if pinned.iter().any(|(p, _)| addressed.contains(p.as_str()) && !pinned_static.contains(p)) {
        return None; // a pointer to an automatic variable could outlive its chunk
    }
    let scalar = |ty: &str| -> bool {
        ty.ends_with('*')
            || matches!(
                ty.trim_start_matches("const ").trim(),
                "tsv" | "double" | "float" | "long long" | "long" | "int" | "unsigned" | "unsigned int" | "bool" | "char"
                    | "int8_t" | "uint8_t" | "int16_t" | "uint16_t" | "int32_t" | "uint32_t" | "int64_t" | "uint64_t"
                    | "size_t" | "ts_key"
            )
    };
    let type_of = |nm: &str| -> String {
        match fscope[nm] {
            usize::MAX => mid_plain.get(nm).map(|m| m.1.clone()).unwrap_or_default(),
            k => pro[k].0.clone(),
        }
    };
    let shared: BTreeSet<String> = users
        .iter()
        .filter(|(nm, u)| {
            !pinned.iter().any(|(p, _)| p == **nm)
                && (u.len() > 1 || addressed.contains(**nm) || !scalar(&type_of(nm)))
        })
        .map(|(nm, _)| nm.to_string())
        .collect();
    let shared_set: HashSet<String> = shared.iter().cloned().collect();
    let tag = format!("{:08x}", fnv1a(name));
    let frame_t = format!("mi__frame_{}", tag);
    let shared_t = format!("mi__shared_{}", tag);
    let mut typedefs = String::new();
    if framed {
        let _ = writeln!(typedefs, "typedef struct {{ {} }} {};", frame_members, frame_t);
    }
    typedefs.push_str("typedef struct {");
    if shared.is_empty() {
        typedefs.push_str(" char mi__unused;");
    } else {
        for nm in &shared {
            let ty = match fscope[nm.as_str()] {
                usize::MAX => mid_plain[nm].1.clone(),
                k => pro[k].0.clone(),
            };
            let _ = write!(typedefs, " {} {};", ty, nm);
        }
    }
    let _ = writeln!(typedefs, " }} {};", shared_t);
    // the chunks
    let mut parts = Vec::new();
    for c in 0..cuts.len() - 1 {
        let pname = format!("{}__part_{}", name, c);
        let mut b = String::new();
        b.push_str("{\n");
        if framed {
            let _ = writeln!(b, "  {st}* mi__s = ({st}*)mi__sp;\n  {ft}* mi__f = ({ft}*)mi__fp;\n  (void)mi__s; (void)mi__f;", st = shared_t, ft = frame_t);
        } else {
            let _ = writeln!(b, "  {st}* mi__s = ({st}*)mi__sp;\n  (void)mi__s; (void)mi__fp;", st = shared_t);
        }
        for (_, nm, _, l) in &pro {
            if !shared_set.contains(nm) && users.get(nm.as_str()).map_or(false, |u| u.len() == 1 && u.contains(&c)) {
                b.push_str(l);
                b.push('\n');
            }
        }
        for i in cuts[c]..cuts[c + 1] {
            let l = body_lines[i];
            let top = i == 0 || dep[i - 1].0 == 0;
            if top {
                if let TopStmt::Plain { name: nm, init, .. } = top_stmt(l) {
                    if shared_set.contains(&nm) {
                        if let Some(init) = init {
                            let _ = writeln!(b, "  mi__s->{} = {};", nm, rewrite_chunk_line(&init, &shared_set));
                        }
                        continue;
                    }
                }
            }
            b.push_str(&rewrite_chunk_line(l, &shared_set));
            b.push('\n');
        }
        b.push_str("}\n");
        let nl = b.matches('\n').count();
        parts.push((pname, b, nl));
    }
    // the caller
    let mut cb = String::new();
    cb.push_str("{\n");
    let _ = writeln!(cb, "  {st} mi__sv = {{0}};\n  {st}* mi__s = &mi__sv;", st = shared_t);
    for (_, nm, init, _) in &pro {
        if shared_set.contains(nm) {
            if let Some(init) = init {
                let _ = writeln!(cb, "  mi__s->{} = {};", nm, init);
            }
        }
    }
    if framed {
        let _ = writeln!(cb, "  {ft} mi__fv;\n  {ft}* mi__f = &mi__fv;", ft = frame_t);
        for l in &frame_inits {
            cb.push_str(&rewrite_chunk_line(l, &HashSet::new()));
            cb.push('\n');
        }
        cb.push_str(&rewrite_chunk_line(push_line, &HashSet::new()));
        cb.push('\n');
    }
    for (pname, _, _) in &parts {
        let _ = writeln!(cb, "  {}(mi__s, {});", pname, if framed { "mi__f" } else { "(void*)0" });
    }
    if framed {
        cb.push_str("  ts_frame_pop(&mi__f->h);\n");
    }
    cb.push_str("  return TS_UNDEFINED;\n}\n");
    Some(InitSplit { caller_body: cb, parts, typedefs })
}

/// Replace each cold function of the module initialization's shape with its
/// caller and chunks; records their units and each unit's preamble (the two
/// struct types).
fn split_init_items(
    items: Vec<Item>,
    opt: &Options,
    forced_unit: &mut HashMap<String, String>,
    preamble: &mut HashMap<String, String>,
    parts_of: &mut HashMap<String, Vec<String>>,
) -> Vec<Item> {
    let names: HashSet<String> = items
        .iter()
        .filter_map(|it| if let Item::Func { name, .. } = it { Some(name.clone()) } else { None })
        .collect();
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let split = match &it {
            Item::Func { name, sig, body, lines } if *lines >= opt.cold_lines => {
                split_init_function(name, sig, body, opt.init_chunk_lines)
                    .filter(|s| s.parts.iter().all(|(pn, _, _)| !names.contains(pn)))
                    .map(|s| (name.clone(), sig.clone(), s))
            }
            _ => None,
        };
        let Some((name, sig, s)) = split else {
            out.push(it);
            continue;
        };
        let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).take(40).collect();
        let unit = |k: usize| format!("init_{}_{}.c", slug, k);
        let caller_lines = s.caller_body.matches('\n').count();
        forced_unit.insert(name.clone(), unit(0));
        preamble.insert(unit(0), s.typedefs.clone());
        let (mut k, mut fill) = (0usize, caller_lines);
        let mut part_names = Vec::new();
        out.push(Item::Func { name: name.clone(), sig, body: s.caller_body, lines: caller_lines });
        for (pname, pbody, plines) in s.parts {
            if fill > 0 && fill + plines > opt.chunk_lines {
                k += 1;
                fill = 0;
                preamble.insert(unit(k), s.typedefs.clone());
            }
            fill += plines;
            forced_unit.insert(pname.clone(), unit(k));
            part_names.push(pname.clone());
            let psig = format!("__attribute__((noinline, visibility(\"hidden\"))) void {}(void* mi__sp, void* mi__fp)", pname);
            out.push(Item::Func { name: pname, sig: psig, body: pbody, lines: plines });
        }
        parts_of.insert(name, part_names);
    }
    out
}

pub struct Unit {
    pub file: String,
    pub cold: bool,
}

/// Split the emitted C into `dir`: prog.h, data.c, the cold units and the
/// function units; returns the units in build order (largest first).
pub fn split(
    c: &str,
    modules: &[String],
    fn_module: &BTreeMap<u32, u32>,
    dir: &Path,
    opt: &Options,
) -> Result<Vec<Unit>, String> {
    let mut items = Vec::new();
    for t in top_level_items(c) {
        items.push(classify(t)?);
    }
    let items = demote_hinted_with_statics(items)?;
    // the module initialization's chunks (docs/startup_design.md, S1)
    let mut forced_unit: HashMap<String, String> = HashMap::new();
    let mut preamble: HashMap<String, String> = HashMap::new();
    let mut parts_of: HashMap<String, Vec<String>> = HashMap::new();
    let items = if opt.split_init {
        split_init_items(items, opt, &mut forced_unit, &mut preamble, &mut parts_of)
    } else {
        items
    };
    let part_caller: HashMap<String, String> = parts_of
        .iter()
        .flat_map(|(caller, parts)| parts.iter().map(move |p| (p.clone(), caller.clone())))
        .collect();
    // functions: unit assignment
    let mut lines_of: HashMap<String, usize> = HashMap::new();
    let mut is_fn: HashSet<String> = HashSet::new();
    for it in &items {
        if let Item::Func { name, lines, .. } = it {
            lines_of.insert(name.clone(), *lines);
            is_fn.insert(name.clone());
        }
    }
    let is_cold = |name: &str, lines: usize| -> bool {
        lines >= opt.cold_lines
            || (lines >= 2000 && name.find("_create").map_or(false, |k| {
                name[k + 7..].chars().next().map_or(false, |c| c.is_ascii_uppercase())
            }))
    };
    // module sizes (non-cold functions)
    let mut module_lines: BTreeMap<u32, usize> = BTreeMap::new();
    for it in &items {
        if let Item::Func { name, lines, .. } = it {
            if name != "main" && !is_cold(name, *lines) && !forced_unit.contains_key(name) {
                if let Some(m) = module_of(name, fn_module) {
                    *module_lines.entry(m).or_insert(0) += lines;
                }
            }
        }
    }
    let unit_name_for_module = |m: u32, k: usize| -> String {
        let path = modules.get(m as usize).map(|s| s.as_str()).unwrap_or("?");
        let base: String = Path::new(path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .take(24)
            .collect();
        format!("m_{}_{:08x}_{}.c", base, fnv1a(path), k)
    };
    // A module above chunk_lines gets units of its own, in chunks of about
    // chunk_lines in emission order (a tail under a quarter of that joins the
    // chunk before it); smaller modules share the bins by a hash of their
    // path; each cold function is a unit of its own. Every choice depends on
    // the module alone, so an edit only moves functions within its module.
    let mut unit_of: HashMap<String, String> = HashMap::new();
    let mut module_fns: BTreeMap<u32, Vec<(String, usize)>> = BTreeMap::new();
    for it in &items {
        if let Item::Func { name, lines, .. } = it {
            let u = if let Some(u) = forced_unit.get(name) {
                Some(u.clone())
            } else if name == "main" {
                Some("data.c".to_string())
            } else if is_cold(name, *lines) {
                let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).take(48).collect();
                Some(format!("cold_{}.c", slug))
            } else if let Some(m) = module_of(name, fn_module) {
                if module_lines[&m] > opt.chunk_lines {
                    module_fns.entry(m).or_default().push((name.clone(), *lines));
                    None
                } else {
                    let path = modules.get(m as usize).map(|s| s.as_str()).unwrap_or("?");
                    Some(format!("bin_{}.c", fnv1a(path) as usize % opt.bins))
                }
            } else {
                Some("data.c".to_string())
            };
            if let Some(u) = u {
                unit_of.insert(name.clone(), u);
            }
        }
    }
    for (m, fns) in &module_fns {
        let mut chunks: Vec<Vec<&String>> = vec![vec![]];
        let mut fill = 0usize;
        let mut sizes: Vec<usize> = vec![0];
        for (name, lines) in fns {
            if fill > 0 && fill + lines > opt.chunk_lines {
                chunks.push(vec![]);
                sizes.push(0);
                fill = 0;
            }
            chunks.last_mut().unwrap().push(name);
            *sizes.last_mut().unwrap() += lines;
            fill += lines;
        }
        if chunks.len() > 1 && sizes[chunks.len() - 1] < opt.chunk_lines / 4 {
            let tail = chunks.pop().unwrap();
            chunks.last_mut().unwrap().extend(tail);
        }
        for (k, chunk) in chunks.iter().enumerate() {
            for name in chunk {
                unit_of.insert((*name).clone(), unit_name_for_module(*m, k));
            }
        }
    }
    // calls and the inline copies
    let mut callers_units: HashMap<String, BTreeSet<String>> = HashMap::new();
    for it in &items {
        if let Item::Func { name, body, .. } = it {
            let u = &unit_of[name];
            for (s, e) in identifiers(body) {
                let id = &body[s..e];
                if id != name && is_fn.contains(id) {
                    callers_units.entry(id.to_string()).or_default().insert(u.clone());
                }
            }
        }
    }
    // the cold units and the module initialization's (run once) call the
    // originals: no copies for them, and their calls make none
    let no_copies = |u: &str| u.starts_with("cold_") || u.starts_with("init_");
    let mut cand: HashSet<String> = HashSet::new();
    for it in &items {
        if let Item::Func { name, body, lines, .. } = it {
            let u = &unit_of[name];
            if no_copies(u) || name == "main" || *lines > opt.inline_lines || has_local_static(body) {
                continue;
            }
            if callers_units.get(name).map_or(false, |us| us.iter().any(|x| x != u && !no_copies(x))) {
                if is_fn.contains(&format!("{}__i", name)) {
                    return Err(format!("the copy's name {}__i is taken", name));
                }
                cand.insert(name.clone());
            }
        }
    }
    // references after the rewrite: which functions stay in their unit
    let mut refs: HashMap<String, BTreeSet<String>> = HashMap::new();
    let note_refs = |text: &str, place: &str, own: Option<&str>, refs: &mut HashMap<String, BTreeSet<String>>| {
        for (s, e) in identifiers(text) {
            let id = &text[s..e];
            if Some(id) != own && is_fn.contains(id) {
                refs.entry(id.to_string()).or_default().insert(place.to_string());
            }
        }
    };
    // A body calls the copies of the functions of other units (a cold unit,
    // compiled without inlining, calls the originals); a copy calls copies.
    let mut rewritten: HashMap<String, String> = HashMap::new();
    let mut copy_text: HashMap<String, String> = HashMap::new();
    let mut copy_uses: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut unit_uses: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for it in &items {
        match it {
            Item::Func { name, body, .. } => {
                let u = &unit_of[name];
                let (rb, used) = if no_copies(u) {
                    (body.clone(), BTreeSet::new())
                } else {
                    rewrite_calls(body, |id| cand.contains(id) && &unit_of[id] != u)
                };
                note_refs(&rb, u, Some(name), &mut refs);
                unit_uses.entry(u.clone()).or_default().extend(used);
                rewritten.insert(name.clone(), rb);
                if cand.contains(name) {
                    // what a copy references is reachable from every unit: extern
                    // (its own name too: a copy that takes the original's address)
                    let (cb, used) = rewrite_calls(body, |id| cand.contains(id));
                    note_refs(&cb, "prog.h", None, &mut refs);
                    copy_text.insert(name.clone(), cb);
                    copy_uses.insert(name.clone(), used);
                }
            }
            Item::Header(t) => note_refs(t, "prog.h", None, &mut refs),
            Item::Data { decl, defn } => {
                note_refs(decl, "prog.h", None, &mut refs);
                note_refs(defn, "data.c", None, &mut refs);
            }
            Item::Proto { .. } => {}
        }
    }
    let local: HashSet<String> = is_fn
        .iter()
        .filter(|f| {
            f.as_str() != "main"
                && refs.get(f.as_str()).map_or(true, |r| r.iter().all(|p| p == &unit_of[f.as_str()]))
        })
        .cloned()
        .collect();
    // the files
    let mut header = String::new();
    let mut data = String::from("#include \"prog.h\"\n");
    let mut units: BTreeMap<String, (String, String)> = BTreeMap::new(); // file -> (protos, defs)
    let mut seen_proto: HashSet<String> = HashSet::new();
    for it in &items {
        match it {
            Item::Header(t) => {
                if (t.trim_start().starts_with("TS_AOT_INLINE") || t.trim_start().starts_with("TS_AOT_HINT"))
                    && has_local_static(t)
                {
                    return Err(format!("a header function with local statics: {}", first_line(t)));
                }
                header.push_str(t);
            }
            Item::Proto { name, text } => {
                let ext = text.trim_start().strip_prefix("static ").unwrap_or(text.trim_start());
                if local.contains(name) {
                    if let Some(u) = unit_of.get(name) {
                        units.entry(u.clone()).or_default().0.push_str(text);
                    }
                } else {
                    header.push_str(ext);
                }
                seen_proto.insert(name.clone());
            }
            Item::Data { decl, defn } => {
                header.push_str(decl);
                data.push_str(defn);
            }
            Item::Func { name, sig, .. } => {
                let u = unit_of[name].clone();
                let body = &rewritten[name];
                let entry = units.entry(u.clone()).or_default();
                if local.contains(name) {
                    if !seen_proto.contains(name) {
                        let _ = writeln!(entry.0, "static {};", sig);
                    }
                    let _ = writeln!(entry.1, "static {}{}", sig, body.trim_end());
                } else {
                    if let Some(caller) = part_caller.get(name) {
                        // the caller's unit declares it: the header does not change with the chunks
                        let cu = unit_of[caller].clone();
                        let _ = writeln!(preamble.entry(cu).or_default(), "{};", sig);
                    } else if !seen_proto.contains(name) && name != "main" {
                        let _ = writeln!(header, "{};", sig);
                    }
                    let entry = units.entry(u.clone()).or_default();
                    let _ = writeln!(entry.1, "{}{}", sig, body.trim_end());
                }
            }
        }
    }
    // hidden visibility for everything the program defines
    let pos = header.rfind("#include").map(|p| header[p..].find('\n').map_or(header.len(), |q| p + q + 1)).unwrap_or(0);
    header.insert_str(pos, "#pragma GCC visibility push(hidden)\n");
    header.push_str("#pragma GCC visibility pop\n");
    // each unit's copies: the ones its bodies call, and the ones those call
    let order: Vec<&String> = items
        .iter()
        .filter_map(|it| match it {
            Item::Func { name, .. } if cand.contains(name) => Some(name),
            _ => None,
        })
        .collect();
    let mut sig_of: HashMap<&str, &str> = HashMap::new();
    for it in &items {
        if let Item::Func { name, sig, .. } = it {
            sig_of.insert(name, sig);
        }
    }
    let copies_for = |uses: &BTreeSet<String>| -> String {
        let mut need: HashSet<&str> = HashSet::new();
        let mut work: Vec<&str> = uses.iter().map(|s| s.as_str()).collect();
        while let Some(f) = work.pop() {
            if need.insert(f) {
                work.extend(copy_uses[f].iter().map(|s| s.as_str()));
            }
        }
        let mut protos = String::new();
        let mut defs = String::new();
        for name in &order {
            if need.contains(name.as_str()) {
                let isig = sig_of[name.as_str()].replacen(&format!("{}(", name), &format!("{}__i(", name), 1);
                let _ = writeln!(protos, "static inline {};", isig);
                let _ = writeln!(defs, "static inline {}{}", isig, copy_text[name.as_str()].trim_end());
            }
        }
        protos + &defs
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let write = |f: &str, s: &str| std::fs::write(dir.join(f), s).map_err(|e| format!("{}: {}", f, e));
    write("prog.h", &header)?;
    let mut sizes: Vec<(usize, String, bool)> = Vec::new();
    if let Some((protos, defs)) = units.remove("data.c") {
        // its static functions' prototypes before the data that may name them
        let copies = unit_uses.get("data.c").map(|u| copies_for(u)).unwrap_or_default();
        data.insert_str("#include \"prog.h\"\n".len(), &(protos + &copies));
        data.push_str(&defs);
    }
    sizes.push((data.len(), "data.c".to_string(), false));
    write("data.c", &data)?;
    for (file, (protos, defs)) in &units {
        let copies = unit_uses.get(file).map(|u| copies_for(u)).unwrap_or_default();
        let pre = preamble.get(file).map(|s| s.as_str()).unwrap_or("");
        let text = format!("#include \"prog.h\"\n{}{}{}{}", pre, protos, copies, defs);
        write(file, &text)?;
        sizes.push((text.len(), file.clone(), file.starts_with("cold_")));
    }
    sizes.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(sizes.into_iter().map(|(_, file, cold)| Unit { file, cold }).collect())
}
