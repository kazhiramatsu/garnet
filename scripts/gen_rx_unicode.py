#!/usr/bin/env python3
"""gen_rx_unicode.py [ucd dir] [out header]: the Unicode tables of the regexp engine
(runtime/regexp/rx_unicode_tables.h, docs/regexp_vm_design.md) from the Unicode Character
Database. Default input build/ucd/<version>/ (downloaded by --fetch from unicode.org), default
output runtime/regexp/rx_unicode_tables.h. Run with `python3 -I`: the input is downloaded data.

Tables:
  rx_canon_list     (cp, canon) pairs, BMP code units whose non-`u` Canonicalize differs from
                    themselves: the Default Case Conversion uppercase (SpecialCasing's unconditional
                    mappings over UnicodeData's simple mapping), kept only when it is one code unit and
                    not an ASCII result of a non-ASCII input (ES2025 22.2.2.7.3 Canonicalize).
  rx_fold_list      (cp, folded) pairs, every code point whose simple case folding (CaseFolding.txt
                    C + S) differs: the `u`/`v` Canonicalize.
  rx_prop_*         inclusive [lo, hi] range tables: General_Category values and groupings, Script,
                    Script_Extensions, the binary properties ECMA-262 lists, ID_Start / ID_Continue.
  rx_prop_names[]   name -> table, every canonical name and alias, sorted for a binary search.
"""
import os, sys, re, urllib.request

VERSION = "17.0.0"
EMOJI_VERSION = "17.0"
FILES = ["UnicodeData.txt", "CaseFolding.txt", "SpecialCasing.txt", "DerivedCoreProperties.txt",
         "PropList.txt", "Scripts.txt", "ScriptExtensions.txt", "PropertyValueAliases.txt",
         "PropertyAliases.txt", "DerivedNormalizationProps.txt", "emoji/emoji-data.txt",
         "extracted/DerivedBinaryProperties.txt", "extracted/DerivedGeneralCategory.txt"]

# ECMA-262 table-binary-unicode-properties (canonical names); the aliases come from PropertyAliases.txt.
BINARY_PROPS = """ASCII ASCII_Hex_Digit Alphabetic Any Assigned Bidi_Control Bidi_Mirrored Case_Ignorable
Cased Changes_When_Casefolded Changes_When_Casemapped Changes_When_Lowercased
Changes_When_NFKC_Casefolded Changes_When_Titlecased Changes_When_Uppercased Dash
Default_Ignorable_Code_Point Deprecated Diacritic Emoji Emoji_Component Emoji_Modifier
Emoji_Modifier_Base Emoji_Presentation Extended_Pictographic Extender Grapheme_Base Grapheme_Extend
Hex_Digit IDS_Binary_Operator IDS_Trinary_Operator ID_Continue ID_Start Ideographic Join_Control
Logical_Order_Exception Lowercase Math Noncharacter_Code_Point Pattern_Syntax Pattern_White_Space
Quotation_Mark Radical Regional_Indicator Sentence_Terminal Soft_Dotted Terminal_Punctuation
Unified_Ideograph Uppercase Variation_Selector White_Space XID_Continue XID_Start""".split()

def fetch(ucd):
    for f in FILES:
        dst = os.path.join(ucd, f)
        if os.path.exists(dst): continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        url = f"https://www.unicode.org/Public/{VERSION}/ucd/{f}"
        print("fetch", url, file=sys.stderr)
        urllib.request.urlretrieve(url, dst)

def lines(path):
    with open(path, encoding="utf-8") as f:
        for l in f:
            l = l.split("#", 1)[0].strip()
            if l: yield [x.strip() for x in l.split(";")]

def cp_range(field):
    if ".." in field:
        a, b = field.split(".."); return int(a, 16), int(b, 16)
    v = int(field, 16); return v, v

def add_range(table, name, lo, hi):
    table.setdefault(name, []).append((lo, hi))

def normalize(ranges):
    """sorted, merged inclusive ranges"""
    out = []
    for lo, hi in sorted(ranges):
        if out and lo <= out[-1][1] + 1: out[-1] = (out[-1][0], max(out[-1][1], hi))
        else: out.append((lo, hi))
    return out

def union(*tables):
    r = []
    for t in tables: r.extend(t)
    return normalize(r)

def subtract(a, b):
    """a minus b, both normalized"""
    out = []; j = 0
    for lo, hi in a:
        cur = lo
        while j < len(b) and b[j][1] < cur: j += 1
        k = j
        while k < len(b) and b[k][0] <= hi:
            blo, bhi = b[k]
            if blo > cur: out.append((cur, blo - 1))
            cur = max(cur, bhi + 1)
            k += 1
        if cur <= hi: out.append((cur, hi))
    return out

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ucd = args[0] if len(args) > 0 else os.path.join(root, "build", "ucd", VERSION)
    out = args[1] if len(args) > 1 else os.path.join(root, "runtime", "regexp", "rx_unicode_tables.h")
    if "--fetch" in sys.argv: fetch(ucd)
    P = lambda f: os.path.join(ucd, f)

    # ---- UnicodeData: simple uppercase, the General_Category comes from the extracted file ----
    simple_upper = {}
    for f in lines(P("UnicodeData.txt")):
        cp = int(f[0], 16)
        if f[12]: simple_upper[cp] = int(f[12], 16)
    full_upper = dict(simple_upper)
    for f in lines(P("SpecialCasing.txt")):
        if len(f) >= 5 and f[4]: continue            # a conditional mapping (language or context)
        cp = int(f[0], 16)
        ups = [int(x, 16) for x in f[3].split()] if f[3] else []
        full_upper[cp] = ups if len(ups) != 1 else ups[0]
    canon = []
    for cp in range(0x10000):
        u = full_upper.get(cp)
        if u is None or isinstance(u, list): continue   # unmapped, or more than one code unit
        if u > 0xFFFF: continue
        if cp >= 128 and u < 128: continue
        if u != cp: canon.append((cp, u))

    fold = []
    for f in lines(P("CaseFolding.txt")):
        if f[1] in ("C", "S"):
            cp, m = int(f[0], 16), int(f[2], 16)
            if m != cp: fold.append((cp, m))
    fold.sort()

    # ---- General_Category ----
    gc = {}
    for f in lines(P("extracted/DerivedGeneralCategory.txt")):
        lo, hi = cp_range(f[0]); add_range(gc, f[1], lo, hi)
    gc = {k: normalize(v) for k, v in gc.items()}
    groups = {"L": "Lu Ll Lt Lm Lo", "LC": "Lu Ll Lt", "M": "Mn Mc Me", "N": "Nd Nl No",
              "P": "Pc Pd Ps Pe Pi Pf Po", "S": "Sm Sc Sk So", "Z": "Zs Zl Zp", "C": "Cc Cf Cs Co Cn"}
    for g, members in groups.items(): gc[g] = union(*(gc[m] for m in members.split()))

    # ---- Script / Script_Extensions ----
    sc = {}
    for f in lines(P("Scripts.txt")):
        lo, hi = cp_range(f[0]); add_range(sc, f[1], lo, hi)
    sc = {k: normalize(v) for k, v in sc.items()}
    all_cps = [(0, 0x10FFFF)]
    sc["Unknown"] = subtract(all_cps, union(*sc.values()))
    short_to_long = {}
    aliases_sc = {}     # alias -> canonical long name
    aliases_gc = {}
    aliases_bin = {}
    for f in lines(P("PropertyValueAliases.txt")):
        if f[0] == "sc":
            short, long_ = f[1], f[2]; short_to_long[short] = long_
            for a in f[1:]: aliases_sc[a] = long_
        elif f[0] == "gc":
            for a in f[1:]: aliases_gc[a] = f[1]
    scx_lists = {}
    for f in lines(P("ScriptExtensions.txt")):
        lo, hi = cp_range(f[0])
        scx_lists.setdefault(tuple(short_to_long[s] for s in f[1].split()), []).append((lo, hi))
    with_scx = union(*scx_lists.values()) if scx_lists else []
    scx = {}
    for name, ranges in sc.items():
        base = subtract(ranges, with_scx)
        extra = [r for scripts, rs in scx_lists.items() if name in scripts for r in rs]
        scx[name] = union(base, extra)

    # ---- binary properties ----
    binp = {}
    for src in ("PropList.txt", "DerivedCoreProperties.txt", "extracted/DerivedBinaryProperties.txt",
                "emoji/emoji-data.txt", "DerivedNormalizationProps.txt"):
        for f in lines(P(src)):
            if len(f) < 2: continue
            lo, hi = cp_range(f[0]); add_range(binp, f[1], lo, hi)
    binp = {k: normalize(v) for k, v in binp.items()}
    binp["Any"] = all_cps
    binp["ASCII"] = [(0, 0x7F)]
    binp["Assigned"] = subtract(all_cps, gc["Cn"])
    for f in lines(P("PropertyAliases.txt")):
        if f[1] in BINARY_PROPS:
            for a in f: aliases_bin[a] = f[1]
    for p in BINARY_PROPS:
        if p not in binp: sys.exit(f"missing binary property {p}")
        aliases_bin[p] = p

    # ---- the registry: (lookup name, kind, canonical table id) ----
    # kind: 0 binary (`\p{Name}`), 1 General_Category value (`\p{Lu}`, `\p{gc=Lu}`), 2 Script value
    # (`\p{sc=Latn}`), 3 Script_Extensions value (`\p{scx=Latn}`). A gc value is also accepted alone.
    tables = {}          # id -> ranges
    def tid(kind, name):
        return f"{['bin','gc','sc','scx'][kind]}_{re.sub('[^A-Za-z0-9_]', '_', name)}"
    names = []
    for alias, canon_name in aliases_bin.items():
        tables[tid(0, canon_name)] = binp[canon_name]; names.append((alias, 0, tid(0, canon_name)))
    for alias, canon_name in aliases_gc.items():
        if canon_name not in gc: continue
        tables[tid(1, canon_name)] = gc[canon_name]; names.append((alias, 1, tid(1, canon_name)))
    for alias, canon_name in aliases_sc.items():
        if canon_name not in sc: continue
        tables[tid(2, canon_name)] = sc[canon_name]; names.append((alias, 2, tid(2, canon_name)))
        tables[tid(3, canon_name)] = scx[canon_name]; names.append((alias, 3, tid(3, canon_name)))
    names.sort(key=lambda t: (t[0], t[1]))
    id_start = binp["ID_Start"]; id_continue = binp["ID_Continue"]

    w = []
    w.append(f"/* Generated by scripts/gen_rx_unicode.py from the Unicode {VERSION} Character Database. Do not edit. */")
    w.append("#ifndef RX_UNICODE_TABLES_H\n#define RX_UNICODE_TABLES_H\n#include <stdint.h>")
    w.append(f'#define RX_UNICODE_VERSION "{VERSION}"')
    def emit_pairs(name, pairs):
        w.append(f"static const uint32_t {name}[{len(pairs) * 2}] = {{")
        row = []
        for a, b in pairs:
            row.append(f"0x{a:X},0x{b:X}")
            if len(row) == 8: w.append("  " + ",".join(row) + ","); row = []
        if row: w.append("  " + ",".join(row) + ",")
        w.append("};")
        w.append(f"#define {name.upper()}_N {len(pairs)}u")
    emit_pairs("rx_canon_list", canon)
    emit_pairs("rx_fold_list", fold)
    for id_, ranges in sorted(tables.items()):
        emit_pairs("rx_prop_" + id_, ranges)
    w.append("typedef struct rx_prop_name { const char* name; uint8_t kind; const uint32_t* ranges; uint32_t n; } rx_prop_name;")
    w.append(f"static const rx_prop_name rx_prop_names[{len(names)}] = {{")
    for alias, kind, id_ in names:
        w.append(f'  {{ "{alias}", {kind}, rx_prop_{id_}, RX_PROP_{id_.upper()}_N }},')
    w.append("};")
    w.append(f"#define RX_PROP_NAMES_N {len(names)}u")
    w.append("#define rx_id_start_ranges rx_prop_bin_ID_Start\n#define rx_id_start_n RX_PROP_BIN_ID_START_N")
    w.append("#define rx_id_continue_ranges rx_prop_bin_ID_Continue\n#define rx_id_continue_n RX_PROP_BIN_ID_CONTINUE_N")
    w.append("#endif")
    with open(out, "w") as f: f.write("\n".join(w) + "\n")
    total = sum(len(r) for r in tables.values())
    print(f"{out}: canon {len(canon)}, fold {len(fold)}, {len(tables)} tables with {total} ranges, {len(names)} names", file=sys.stderr)

if __name__ == "__main__":
    main()
