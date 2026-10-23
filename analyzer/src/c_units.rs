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
            if name != "main" && !is_cold(name, *lines) {
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
            let u = if name == "main" {
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
    let mut cand: HashSet<String> = HashSet::new();
    for it in &items {
        if let Item::Func { name, body, lines, .. } = it {
            let u = &unit_of[name];
            if u.starts_with("cold_") || name == "main" || *lines > opt.inline_lines || has_local_static(body) {
                continue;
            }
            if callers_units.get(name).map_or(false, |us| us.iter().any(|x| x != u && !x.starts_with("cold_"))) {
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
                let (rb, used) = if u.starts_with("cold_") {
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
                    if !seen_proto.contains(name) && name != "main" {
                        let _ = writeln!(header, "{};", sig);
                    }
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
        let text = format!("#include \"prog.h\"\n{}{}{}", protos, copies, defs);
        write(file, &text)?;
        sizes.push((text.len(), file.clone(), file.starts_with("cold_")));
    }
    sizes.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(sizes.into_iter().map(|(_, file, cold)| Unit { file, cold }).collect())
}
