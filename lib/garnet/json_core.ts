// garnet:json core (docs/typed_json_design.md): the schema-driven parser shared by
// the garnet binding (json.ts) and the Node polyfill (json_node.ts). A schema is
// compiled once from the JSON string the exporter derives from the call's type
// argument; the parser validates the text against it as it goes and builds the
// objects through `makeObject`, which gives each one the literal layout of its
// keys (garnet) or a plain object with the same key order (Node).
//
// The scanners are tight loops over charCodeAt (the emitter hoists a string's
// view for a loop without calls): a key is hashed in place and matched against
// the type's keys without a string allocation, a number of at most 15 digits
// whose decimal exponent is within ±22 is converted exactly from its digits,
// and an undeclared property's value is skipped without being built.

/** A layout handle for a key sequence (opaque: the runtime's layout id under garnet). */
export type Layout = unknown;
export type MakeLayout = (keys: string[]) => Layout;
export type MakeObject = (layout: Layout, values: unknown[]) => unknown;

const K_NUM = 1, K_STR = 2, K_BOOL = 3, K_NULL = 4, K_ANY = 5, K_LIT = 6, K_ARR = 7,
  K_TUPLE = 8, K_RECORD = 9, K_OBJ = 10, K_UNION = 11, K_REF = 12;
/** Token kinds, by a value's first character. */
const T_OBJECT = 1, T_ARRAY = 2, T_STRING = 3, T_NUMBER = 4, T_TRUE = 5, T_FALSE = 6, T_NULL = 7;
const TOKEN_NAMES = ["", "object", "array", "string", "number", "boolean", "boolean", "null"];
/** An object of up to this many properties tracks its present properties in one bitmask. */
const NARROW_KEYS = 31;

const CH_TAB = 9, CH_LF = 10, CH_CR = 13, CH_SPACE = 32, CH_QUOTE = 34, CH_PLUS = 43, CH_COMMA = 44,
  CH_MINUS = 45, CH_DOT = 46, CH_SLASH = 47, CH_0 = 48, CH_9 = 57, CH_COLON = 58, CH_E = 69,
  CH_LBRACKET = 91, CH_BACKSLASH = 92, CH_RBRACKET = 93, CH_b = 98, CH_e = 101, CH_f = 102,
  CH_n = 110, CH_r = 114, CH_t = 116, CH_u = 117, CH_LBRACE = 123, CH_RBRACE = 125;
const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

function keyHash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return h;
}
/** Whether `text[start, start+len)` spells the key whose char codes are `codes`. */
function keyEquals(codes: number[], text: string, start: number, len: number): boolean {
  if (codes.length !== len) return false;
  for (let i = 0; i < len; i++) if (codes[i] !== text.charCodeAt(start + i)) return false;
  return true;
}
function charCodes(key: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < key.length; i++) out.push(key.charCodeAt(i));
  return out;
}

export class Schema {
  constructor(readonly kind: number) {}
  describe(): string { return "?"; }
}
class PrimSchema extends Schema {
  constructor(kind: number, readonly name: string) { super(kind); }
  describe(): string { return this.name; }
}
class LitSchema extends Schema {
  constructor(readonly value: string | number | boolean) { super(K_LIT); }
  describe(): string { return JSON.stringify(this.value); }
}
class ArrSchema extends Schema {
  constructor(readonly elem: Schema) { super(K_ARR); }
  describe(): string { return this.elem.describe() + "[]"; }
}
class TupleSchema extends Schema {
  constructor(readonly elems: Schema[]) { super(K_TUPLE); }
  describe(): string { return "[" + this.elems.map((e) => e.describe()).join(", ") + "]"; }
}
class RecordSchema extends Schema {
  constructor(readonly elem: Schema) { super(K_RECORD); }
  describe(): string { return "Record<string, " + this.elem.describe() + ">"; }
}
class ObjSchema extends Schema {
  readonly n: number;
  readonly narrow: boolean;
  readonly index = new Map<string, number>();   // key -> slot (an escaped key takes this path)
  readonly codes: number[][] = [];              // slot -> the key's char codes
  readonly tabMask: number;                     // the probe table: hash -> slot, open addressing
  readonly tabHash: number[] = [];
  readonly tabSlot: number[] = [];
  readonly required: number;                    // the mask of the required slots (narrow)
  readonly all: number;                         // the mask of every slot (narrow)
  readonly layouts = new Map<number, Layout>();
  readonly layoutsWide = new Map<string, Layout>();
  readonly scratch: unknown[][] = [];           // per nesting depth, the values of the object being parsed
  constructor(readonly keys: string[], readonly schemas: Schema[], readonly optional: boolean[], readonly makeLayout: MakeLayout) {
    super(K_OBJ);
    const n = keys.length;
    this.n = n;
    this.narrow = n <= NARROW_KEYS;
    let size = 4;
    while (size < n * 2) size *= 2;
    this.tabMask = size - 1;
    for (let i = 0; i < size; i++) { this.tabHash.push(0); this.tabSlot.push(-1); }
    let required = 0, all = 0;
    for (let i = 0; i < n; i++) {
      this.index.set(keys[i], i);
      this.codes.push(charCodes(keys[i]));
      const h = keyHash(keys[i]);
      let j = h & this.tabMask;
      while (this.tabSlot[j] >= 0) j = (j + 1) & this.tabMask;
      this.tabHash[j] = h; this.tabSlot[j] = i;
      if (this.narrow) { all |= (1 << i); if (!optional[i]) required |= (1 << i); }
    }
    this.required = required;
    this.all = all;
  }
  /** The values array for an object at nesting depth `depth` (reused: makeObject copies). */
  valuesAt(depth: number): unknown[] {
    while (this.scratch.length <= depth) this.scratch.push(new Array(this.n));
    return this.scratch[depth];
  }
  describe(): string { return "{ " + this.keys.map((k, i) => k + (this.optional[i] ? "?" : "") + ": " + this.schemas[i].describe()).join("; ") + " }"; }
  /** The slot of the key `text[start, start+len)` whose scan hash is `h`, or -1. */
  slotOf(h: number, text: string, start: number, len: number): number {
    const mask = this.tabMask;
    let j = h & mask;
    for (;;) {
      const slot = this.tabSlot[j];
      if (slot < 0) return -1;
      if (this.tabHash[j] === h && keyEquals(this.codes[slot], text, start, len)) return slot;
      j = (j + 1) & mask;
    }
  }
  /** The layout of the properties present (a bitmask of the slots). */
  layoutFor(mask: number): Layout {
    let l = this.layouts.get(mask);
    if (l === undefined) {
      const keys: string[] = [];
      for (let i = 0; i < this.n; i++) if (mask & (1 << i)) keys.push(this.keys[i]);
      l = this.makeLayout(keys);
      this.layouts.set(mask, l);
    }
    return l;
  }
  layoutForWide(present: boolean[]): Layout {
    let mask = "";
    for (let i = 0; i < this.n; i++) mask += present[i] ? "1" : "0";
    let l = this.layoutsWide.get(mask);
    if (l === undefined) {
      const keys: string[] = [];
      for (let i = 0; i < this.n; i++) if (present[i]) keys.push(this.keys[i]);
      l = this.makeLayout(keys);
      this.layoutsWide.set(mask, l);
    }
    return l;
  }
}
class UnionSchema extends Schema {
  constructor(readonly members: Schema[]) { super(K_UNION); }
  describe(): string { return this.members.map((m) => m.describe()).join(" | "); }
}
class RefSchema extends Schema {
  target: Schema | undefined = undefined;
  constructor(readonly name: string) { super(K_REF); }
  describe(): string { return this.name; }
}

type SchemaJson = string | { k: string; v?: unknown; e?: SchemaJson | SchemaJson[]; p?: [string, SchemaJson, number][]; m?: SchemaJson[]; n?: string };

const compiled = new Map<string, Schema>();

/** Compile a schema string (JSON, docs/typed_json_design.md) once. */
export function compileSchema(text: string, makeLayout: MakeLayout): Schema {
  const cached = compiled.get(text);
  if (cached !== undefined) return cached;
  const root = JSON.parse(text) as { d?: Record<string, SchemaJson>; s: SchemaJson };
  const refs: RefSchema[] = [];
  const defs = new Map<string, Schema>();
  const build = (j: SchemaJson): Schema => {
    if (typeof j === "string") {
      switch (j) {
        case "n": return new PrimSchema(K_NUM, "number");
        case "s": return new PrimSchema(K_STR, "string");
        case "b": return new PrimSchema(K_BOOL, "boolean");
        case "z": return new PrimSchema(K_NULL, "null");
        case "*": return new PrimSchema(K_ANY, "any");
      }
      throw new TypeError("garnet:json: unknown schema " + j);
    }
    switch (j.k) {
      case "l": return new LitSchema(j.v as string | number | boolean);
      case "a": return new ArrSchema(build(j.e as SchemaJson));
      case "t": return new TupleSchema((j.e as SchemaJson[]).map(build));
      case "r": return new RecordSchema(build(j.e as SchemaJson));
      case "o": {
        const props = j.p as [string, SchemaJson, number][];
        return new ObjSchema(props.map((p) => p[0]), props.map((p) => build(p[1])), props.map((p) => p[2] === 1), makeLayout);
      }
      case "u": return new UnionSchema((j.m as SchemaJson[]).map(build));
      case "ref": { const r = new RefSchema(j.n as string); refs.push(r); return r; }
    }
    throw new TypeError("garnet:json: unknown schema kind " + j.k);
  };
  if (root.d !== undefined) for (const name of Object.keys(root.d)) defs.set(name, build(root.d[name]));
  const schema = build(root.s);
  for (const r of refs) {
    const t = defs.get(r.name);
    if (t === undefined) throw new TypeError("garnet:json: undefined schema reference " + r.name);
    r.target = t;
  }
  compiled.set(text, schema);
  return schema;
}

function deref(s: Schema): Schema {
  while (s.kind === K_REF) s = (s as RefSchema).target!;
  return s;
}

class NoMatch { readonly noMatch = true; }
const NO_MATCH = new NoMatch();

class Parser {
  pos = 0;
  /** The path to the value being parsed: per level an object schema and a slot, an array index, or a record key. */
  depth = 0;
  readonly pathSchema: (ObjSchema | undefined)[] = [];
  readonly pathIndex: number[] = [];
  readonly pathKey: (string | undefined)[] = [];
  constructor(readonly text: string, readonly makeObject: MakeObject) {}

  fail(message: string): never { throw new SyntaxError("garnet:json: " + message + " at position " + this.pos); }
  pathString(): string {
    let s = "$";
    for (let d = 0; d < this.depth; d++) {
      const sc = this.pathSchema[d];
      if (sc !== undefined) s += "." + sc.keys[this.pathIndex[d]];
      else if (this.pathKey[d] !== undefined) s += "." + this.pathKey[d];
      else s += "[" + this.pathIndex[d] + "]";
    }
    return s;
  }
  mismatch(expected: string, received: string): never {
    throw new TypeError(this.pathString() + " must be " + expected + ", received " + received);
  }
  /** Enter a container: its object schema (a property's path element is the slot), or an array (the index), or a record (the key). */
  push(schema: ObjSchema | undefined, key: string | undefined): void {
    if (this.depth === this.pathIndex.length) { this.pathSchema.push(schema); this.pathIndex.push(0); this.pathKey.push(key); }
    else { this.pathSchema[this.depth] = schema; this.pathIndex[this.depth] = 0; this.pathKey[this.depth] = key; }
    this.depth++;
  }
  pop(): void { this.depth--; }
  skipWs(): void {
    const t = this.text; const n = t.length; let p = this.pos;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === CH_SPACE || c === CH_LF || c === CH_CR || c === CH_TAB) p++; else break;
    }
    this.pos = p;
  }
  /** The kind of the value at the cursor, by its first character. */
  peekToken(): number {
    if (this.pos >= this.text.length) this.fail("unexpected end of input");
    const c = this.text.charCodeAt(this.pos);
    if (c === CH_QUOTE) return T_STRING;
    if (c === CH_LBRACE) return T_OBJECT;
    if (c === CH_LBRACKET) return T_ARRAY;
    if (c === CH_MINUS || (c >= CH_0 && c <= CH_9)) return T_NUMBER;
    if (c === CH_t) return T_TRUE;
    if (c === CH_f) return T_FALSE;
    if (c === CH_n) return T_NULL;
    this.fail("unexpected character " + JSON.stringify(this.text[this.pos]));
  }
  parseString(): string {
    const t = this.text; const n = t.length;
    if (this.pos >= n || t.charCodeAt(this.pos) !== CH_QUOTE) this.fail("expected a string");
    const start = this.pos + 1; let p = start;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === CH_QUOTE || c === CH_BACKSLASH || c < 32) break;
      p++;
    }
    if (p < n && t.charCodeAt(p) === CH_QUOTE) { this.pos = p + 1; return t.slice(start, p); }
    return this.parseStringSlow(start, p);
  }
  /** The rest of a string from its first escape or control character. */
  parseStringSlow(start: number, p: number): string {
    const t = this.text; const n = t.length;
    let out = t.slice(start, p);
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === CH_QUOTE) { this.pos = p + 1; return out; }
      if (c === CH_BACKSLASH) {
        if (p + 1 >= n) { this.pos = p; this.fail("an unterminated escape"); }
        const e = t.charCodeAt(p + 1);
        switch (e) {
          case CH_QUOTE: out += '"'; p += 2; break;
          case CH_BACKSLASH: out += "\\"; p += 2; break;
          case CH_SLASH: out += "/"; p += 2; break;
          case CH_b: out += "\b"; p += 2; break;
          case CH_f: out += "\f"; p += 2; break;
          case CH_n: out += "\n"; p += 2; break;
          case CH_r: out += "\r"; p += 2; break;
          case CH_t: out += "\t"; p += 2; break;
          case CH_u: {
            if (p + 6 > n) { this.pos = p; this.fail("a short unicode escape"); }
            let code = 0;
            for (let i = p + 2; i < p + 6; i++) {
              const h = t.charCodeAt(i);
              let d: number;
              if (h >= CH_0 && h <= CH_9) d = h - CH_0;
              else if (h >= 97 && h <= 102) d = h - 87;
              else if (h >= 65 && h <= 70) d = h - 55;
              else { this.pos = i; this.fail("a bad unicode escape"); }
              code = code * 16 + d;
            }
            out += String.fromCharCode(code); p += 6; break;
          }
          default: this.pos = p; this.fail("a bad escape");
        }
        continue;
      }
      if (c < 32) { this.pos = p; this.fail("a control character in a string"); }
      let q = p + 1;
      while (q < n) { const d = t.charCodeAt(q); if (d === CH_QUOTE || d === CH_BACKSLASH || d < 32) break; q++; }
      out += t.slice(p, q); p = q;
    }
    this.pos = p; this.fail("an unterminated string");
  }
  parseNumber(): number {
    const t = this.text; const n = t.length; const start = this.pos; let p = start;
    let neg = false;
    if (t.charCodeAt(p) === CH_MINUS) { neg = true; p++; }
    if (p >= n) { this.pos = p; this.fail("a digit"); }
    let c = t.charCodeAt(p);
    let mant = 0, digits = 0, scale = 0;
    if (c === CH_0) p++;
    else if (c >= 49 && c <= CH_9) {
      while (p < n) { c = t.charCodeAt(p); if (c < CH_0 || c > CH_9) break; mant = mant * 10 + (c - CH_0); digits++; p++; }
    } else { this.pos = p; this.fail("a digit"); }
    if (p < n && t.charCodeAt(p) === CH_DOT) {
      p++; const ds = p;
      while (p < n) { c = t.charCodeAt(p); if (c < CH_0 || c > CH_9) break; mant = mant * 10 + (c - CH_0); digits++; scale--; p++; }
      if (p === ds) { this.pos = p; this.fail("a digit after the point"); }
    }
    if (p < n) {
      c = t.charCodeAt(p);
      if (c === CH_e || c === CH_E) {
        p++;
        let eneg = false;
        if (p < n) { c = t.charCodeAt(p); if (c === CH_PLUS) p++; else if (c === CH_MINUS) { eneg = true; p++; } }
        const ds = p; let e = 0;
        while (p < n) { c = t.charCodeAt(p); if (c < CH_0 || c > CH_9) break; if (e < 100000) e = e * 10 + (c - CH_0); p++; }
        if (p === ds) { this.pos = p; this.fail("a digit in the exponent"); }
        scale += eneg ? -e : e;
      }
    }
    this.pos = p;
    let v: number;
    // at most 15 digits (an exact significand) scaled by an exact power of ten: one rounding
    if (digits <= 15 && scale >= -22 && scale <= 22) v = scale === 0 ? mant : scale > 0 ? mant * POW10[scale] : mant / POW10[-scale];
    else v = Number(t.slice(start, p));
    return neg ? -v : v;
  }
  parseWord(word: string): void {
    const t = this.text;
    for (let i = 0; i < word.length; i++) {
      if (this.pos + i >= t.length || t.charCodeAt(this.pos + i) !== word.charCodeAt(i)) this.fail("expected " + word);
    }
    this.pos += word.length;
  }
  /** Over a value without building it (an undeclared property). */
  skipValue(): void {
    this.skipWs();
    const t = this.text; const n = t.length;
    const tok = this.peekToken();
    switch (tok) {
      case T_STRING: {
        let p = this.pos + 1;
        while (p < n) { const c = t.charCodeAt(p); if (c === CH_QUOTE || c === CH_BACKSLASH || c < 32) break; p++; }
        if (p < n && t.charCodeAt(p) === CH_QUOTE) this.pos = p + 1; else this.parseString();
        return;
      }
      case T_NUMBER: this.parseNumber(); return;
      case T_TRUE: this.parseWord("true"); return;
      case T_FALSE: this.parseWord("false"); return;
      case T_NULL: this.parseWord("null"); return;
      case T_ARRAY: {
        this.pos++; this.skipWs();
        if (this.pos < n && t.charCodeAt(this.pos) === CH_RBRACKET) { this.pos++; return; }
        for (;;) {
          this.skipValue(); this.skipWs();
          const c = this.pos < n ? t.charCodeAt(this.pos) : -1;
          if (c === CH_COMMA) { this.pos++; continue; }
          if (c === CH_RBRACKET) { this.pos++; return; }
          this.fail("expected , or ]");
        }
      }
      default: {
        this.pos++; this.skipWs();
        if (this.pos < n && t.charCodeAt(this.pos) === CH_RBRACE) { this.pos++; return; }
        for (;;) {
          this.skipWs(); this.parseString(); this.skipWs();
          if (this.pos >= n || t.charCodeAt(this.pos) !== CH_COLON) this.fail("expected :");
          this.pos++;
          this.skipValue(); this.skipWs();
          const c = this.pos < n ? t.charCodeAt(this.pos) : -1;
          if (c === CH_COMMA) { this.pos++; continue; }
          if (c === CH_RBRACE) { this.pos++; return; }
          this.fail("expected , or }");
        }
      }
    }
  }
  /** A value of no particular type: plain objects and arrays, as JSON.parse builds them. */
  parseAny(): unknown {
    this.skipWs();
    const t = this.text; const n = t.length;
    const tok = this.peekToken();
    switch (tok) {
      case T_STRING: return this.parseString();
      case T_NUMBER: return this.parseNumber();
      case T_TRUE: this.parseWord("true"); return true;
      case T_FALSE: this.parseWord("false"); return false;
      case T_NULL: this.parseWord("null"); return null;
      case T_ARRAY: {
        this.pos++;
        const out: unknown[] = [];
        this.skipWs();
        if (this.pos < n && t.charCodeAt(this.pos) === CH_RBRACKET) { this.pos++; return out; }
        for (;;) {
          out.push(this.parseAny());
          this.skipWs();
          const c = this.pos < n ? t.charCodeAt(this.pos) : -1;
          if (c === CH_COMMA) { this.pos++; continue; }
          if (c === CH_RBRACKET) { this.pos++; return out; }
          this.fail("expected , or ]");
        }
      }
      default: {
        this.pos++;
        const out: Record<string, unknown> = {};
        this.skipWs();
        if (this.pos < n && t.charCodeAt(this.pos) === CH_RBRACE) { this.pos++; return out; }
        for (;;) {
          this.skipWs();
          const key = this.parseString();
          this.skipWs();
          if (this.pos >= n || t.charCodeAt(this.pos) !== CH_COLON) this.fail("expected :");
          this.pos++;
          out[key] = this.parseAny();
          this.skipWs();
          const c = this.pos < n ? t.charCodeAt(this.pos) : -1;
          if (c === CH_COMMA) { this.pos++; continue; }
          if (c === CH_RBRACE) { this.pos++; return out; }
          this.fail("expected , or }");
        }
      }
    }
  }
  tokenName(): string { return TOKEN_NAMES[this.peekToken()]; }
  /** A value of the schema, validated as it is parsed. */
  parseValue(schema: Schema): unknown {
    const t = this.text; const n = t.length;
    let c = this.pos < n ? t.charCodeAt(this.pos) : -1;
    if (c <= CH_SPACE) { this.skipWs(); c = this.pos < n ? t.charCodeAt(this.pos) : -1; }
    if (c < 0) this.fail("unexpected end of input");
    if (schema.kind === K_REF) schema = deref(schema);
    switch (schema.kind) {
      case K_OBJ:
        if (c !== CH_LBRACE) this.mismatch(schema.describe(), this.tokenName());
        return this.parseObject(schema as ObjSchema);
      case K_NUM:
        if (c !== CH_MINUS && (c < CH_0 || c > CH_9)) this.mismatch("number", this.tokenName());
        return this.parseNumber();
      case K_STR:
        if (c !== CH_QUOTE) this.mismatch("string", this.tokenName());
        return this.parseString();
      case K_BOOL:
        if (c === CH_t) { this.parseWord("true"); return true; }
        if (c === CH_f) { this.parseWord("false"); return false; }
        this.mismatch("boolean", this.tokenName());
      case K_ARR:
        if (c !== CH_LBRACKET) this.mismatch((schema as ArrSchema).elem.describe() + "[]", this.tokenName());
        return this.parseArray((schema as ArrSchema).elem, undefined);
      case K_NULL:
        if (c !== CH_n) this.mismatch("null", this.tokenName());
        this.parseWord("null"); return null;
      case K_ANY: return this.parseAny();
    }
    const tok = this.peekToken();
    switch (schema.kind) {
      case K_LIT: {
        const lit = (schema as LitSchema).value;
        let v: unknown;
        if (typeof lit === "string") { if (tok !== T_STRING) this.mismatch(JSON.stringify(lit), TOKEN_NAMES[tok]); v = this.parseString(); }
        else if (typeof lit === "number") { if (tok !== T_NUMBER) this.mismatch(JSON.stringify(lit), TOKEN_NAMES[tok]); v = this.parseNumber(); }
        else if (tok === T_TRUE) { this.parseWord("true"); v = true; }
        else if (tok === T_FALSE) { this.parseWord("false"); v = false; }
        else this.mismatch(JSON.stringify(lit), TOKEN_NAMES[tok]);
        if (v !== lit) this.mismatch(JSON.stringify(lit), JSON.stringify(v));
        return v;
      }
      case K_TUPLE:
        if (tok !== T_ARRAY) this.mismatch(schema.describe(), TOKEN_NAMES[tok]);
        return this.parseArray(undefined, (schema as TupleSchema).elems);
      case K_RECORD:
        if (tok !== T_OBJECT) this.mismatch(schema.describe(), TOKEN_NAMES[tok]);
        return this.parseRecord((schema as RecordSchema).elem);
      case K_UNION: return this.parseUnion(schema as UnionSchema, tok);
    }
    throw new TypeError("garnet:json: bad schema");
  }
  parseArray(elem: Schema | undefined, elems: Schema[] | undefined): unknown[] {
    const t = this.text; const n = t.length;
    this.pos++;
    const out: unknown[] = [];
    let c = this.pos < n ? t.charCodeAt(this.pos) : -1;
    if (c <= CH_SPACE) { this.skipWs(); c = this.pos < n ? t.charCodeAt(this.pos) : -1; }
    if (c === CH_RBRACKET) this.pos++;
    else {
      this.push(undefined, undefined);
      for (;;) {
        const i = out.length;
        this.pathIndex[this.depth - 1] = i;
        let s: Schema;
        if (elems !== undefined) {
          if (i >= elems.length) { this.pop(); this.mismatch("a tuple of " + elems.length + " elements", "more"); }
          s = elems[i];
        } else s = elem!;
        out.push(this.parseValue(s));
        c = this.pos < n ? t.charCodeAt(this.pos) : -1;
        if (c <= CH_SPACE) { this.skipWs(); c = this.pos < n ? t.charCodeAt(this.pos) : -1; }
        if (c === CH_COMMA) { this.pos++; continue; }
        if (c === CH_RBRACKET) { this.pos++; break; }
        this.fail("expected , or ]");
      }
      this.pop();
    }
    if (elems !== undefined && out.length !== elems.length) this.mismatch("a tuple of " + elems.length + " elements", out.length + " elements");
    return out;
  }
  parseRecord(elem: Schema): Record<string, unknown> {
    const t = this.text; const n = t.length;
    this.pos++;
    const out: Record<string, unknown> = {};
    this.skipWs();
    if (this.pos < n && t.charCodeAt(this.pos) === CH_RBRACE) { this.pos++; return out; }
    for (;;) {
      this.skipWs();
      const key = this.parseString();
      this.skipWs();
      if (this.pos >= n || t.charCodeAt(this.pos) !== CH_COLON) this.fail("expected :");
      this.pos++;
      this.push(undefined, key);
      out[key] = this.parseValue(elem);
      this.pop();
      this.skipWs();
      const c = this.pos < n ? t.charCodeAt(this.pos) : -1;
      if (c === CH_COMMA) { this.pos++; continue; }
      if (c === CH_RBRACE) { this.pos++; return out; }
      this.fail("expected , or }");
    }
  }
  parseObject(schema: ObjSchema): unknown {
    if (!schema.narrow) return this.parseObjectWide(schema);
    const t = this.text; const n = t.length;
    this.pos++;
    const count = schema.n;
    const values = schema.valuesAt(this.depth);
    const tabMask = schema.tabMask, tabHash = schema.tabHash, tabSlot = schema.tabSlot, codes = schema.codes;
    let present = 0;
    let c = this.pos < n ? t.charCodeAt(this.pos) : -1;
    if (c <= CH_SPACE) { this.skipWs(); c = this.pos < n ? t.charCodeAt(this.pos) : -1; }
    if (c === CH_RBRACE) this.pos++;
    else {
      this.push(schema, undefined);
      for (;;) {
        c = this.pos < n ? t.charCodeAt(this.pos) : -1;
        if (c <= CH_SPACE) { this.skipWs(); c = this.pos < n ? t.charCodeAt(this.pos) : -1; }
        if (c !== CH_QUOTE) this.fail("expected a string");
        // the key, hashed in place and probed in the schema's table; an escape or a
        // control character takes the string path
        const ks = this.pos + 1; let p = ks; let h = 0;
        while (p < n) {
          const d = t.charCodeAt(p);
          if (d === CH_QUOTE || d === CH_BACKSLASH || d < 32) break;
          h = (h * 31 + d) | 0; p++;
        }
        let slot = -1;
        if (p < n && t.charCodeAt(p) === CH_QUOTE) {
          const len = p - ks;
          let j = h & tabMask;
          for (;;) {
            const cand = tabSlot[j];
            if (cand < 0) break;
            if (tabHash[j] === h) {
              const kc = codes[cand];
              if (kc.length === len) {
                let i = 0;
                while (i < len && kc[i] === t.charCodeAt(ks + i)) i++;
                if (i === len) { slot = cand; break; }
              }
            }
            j = (j + 1) & tabMask;
          }
          this.pos = p + 1;
        } else {
          const i = schema.index.get(this.parseString());
          if (i !== undefined) slot = i;
        }
        c = this.pos < n ? t.charCodeAt(this.pos) : -1;
        if (c <= CH_SPACE) { this.skipWs(); c = this.pos < n ? t.charCodeAt(this.pos) : -1; }
        if (c !== CH_COLON) this.fail("expected :");
        this.pos++;
        if (slot < 0) this.skipValue();
        else {
          this.pathIndex[this.depth - 1] = slot;
          values[slot] = this.parseValue(schema.schemas[slot]);
          present |= (1 << slot);
        }
        c = this.pos < n ? t.charCodeAt(this.pos) : -1;
        if (c <= CH_SPACE) { this.skipWs(); c = this.pos < n ? t.charCodeAt(this.pos) : -1; }
        if (c === CH_COMMA) { this.pos++; continue; }
        if (c === CH_RBRACE) { this.pos++; break; }
        this.fail("expected , or }");
      }
      this.pop();
    }
    if ((present & schema.required) !== schema.required) {
      for (let i = 0; i < count; i++) if (!schema.optional[i] && !(present & (1 << i))) throw new TypeError(this.pathString() + "." + schema.keys[i] + " is missing");
    }
    if (present === schema.all) return this.makeObject(schema.layoutFor(present), values);
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) if (present & (1 << i)) out.push(values[i]);
    return this.makeObject(schema.layoutFor(present), out);
  }
  /** An object type of more than NARROW_KEYS properties: the present set as an array. */
  parseObjectWide(schema: ObjSchema): unknown {
    const t = this.text; const n = t.length;
    this.pos++;
    const count = schema.n;
    const values: unknown[] = new Array(count);
    const present: boolean[] = new Array(count);
    for (let i = 0; i < count; i++) present[i] = false;
    this.skipWs();
    if (this.pos < n && t.charCodeAt(this.pos) === CH_RBRACE) this.pos++;
    else {
      for (;;) {
        this.skipWs();
        const key = this.parseString();
        this.skipWs();
        if (this.pos >= n || t.charCodeAt(this.pos) !== CH_COLON) this.fail("expected :");
        this.pos++;
        const i = schema.index.get(key);
        if (i === undefined) this.skipValue();
        else {
          this.push(schema, undefined);
          this.pathIndex[this.depth - 1] = i;
          values[i] = this.parseValue(schema.schemas[i]);
          present[i] = true;
          this.pop();
        }
        this.skipWs();
        const c = this.pos < n ? t.charCodeAt(this.pos) : -1;
        if (c === CH_COMMA) { this.pos++; continue; }
        if (c === CH_RBRACE) { this.pos++; break; }
        this.fail("expected , or }");
      }
    }
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) {
      if (present[i]) out.push(values[i]);
      else if (!schema.optional[i]) throw new TypeError(this.pathString() + "." + schema.keys[i] + " is missing");
    }
    return this.makeObject(schema.layoutForWide(present), out);
  }
  parseUnion(schema: UnionSchema, tok: number): unknown {
    // the members the token admits
    const candidates: Schema[] = [];
    for (const m0 of schema.members) {
      const m = deref(m0);
      let ok = false;
      switch (m.kind) {
        case K_ANY: case K_UNION: ok = true; break;
        case K_NUM: ok = tok === T_NUMBER; break;
        case K_STR: ok = tok === T_STRING; break;
        case K_BOOL: ok = tok === T_TRUE || tok === T_FALSE; break;
        case K_NULL: ok = tok === T_NULL; break;
        case K_LIT: {
          const lit = (m as LitSchema).value;
          ok = typeof lit === "string" ? tok === T_STRING : typeof lit === "number" ? tok === T_NUMBER : (tok === T_TRUE || tok === T_FALSE);
          break;
        }
        case K_ARR: case K_TUPLE: ok = tok === T_ARRAY; break;
        case K_RECORD: case K_OBJ: ok = tok === T_OBJECT; break;
      }
      if (ok) candidates.push(m);
    }
    if (candidates.length === 0) this.mismatch(schema.describe(), TOKEN_NAMES[tok]);
    if (candidates.length === 1) return this.parseValue(candidates[0]);
    // several members admit the token: parse it, then validate against each in order
    const start = this.pos;
    const value = this.parseAny();
    for (const m of candidates) {
      const r = this.validateValue(value, m);
      if (r !== NO_MATCH) return r;
    }
    this.pos = start;
    this.mismatch(schema.describe(), JSON.stringify(value).slice(0, 60));
  }
  /** Validate (and rebuild through the layouts) a plain value against a schema; NO_MATCH when it does not fit. */
  validateValue(value: unknown, schema: Schema): unknown {
    schema = deref(schema);
    switch (schema.kind) {
      case K_ANY: return value;
      case K_NUM: return typeof value === "number" ? value : NO_MATCH;
      case K_STR: return typeof value === "string" ? value : NO_MATCH;
      case K_BOOL: return typeof value === "boolean" ? value : NO_MATCH;
      case K_NULL: return value === null ? value : NO_MATCH;
      case K_LIT: return value === (schema as LitSchema).value ? value : NO_MATCH;
      case K_ARR: {
        if (!Array.isArray(value)) return NO_MATCH;
        const out: unknown[] = [];
        this.push(undefined, undefined);
        for (let i = 0; i < value.length; i++) {
          this.pathIndex[this.depth - 1] = i;
          const r = this.validateValue(value[i], (schema as ArrSchema).elem);
          if (r === NO_MATCH) { this.pop(); return NO_MATCH; }
          out.push(r);
        }
        this.pop();
        return out;
      }
      case K_TUPLE: {
        const elems = (schema as TupleSchema).elems;
        if (!Array.isArray(value) || value.length !== elems.length) return NO_MATCH;
        const out: unknown[] = [];
        for (let i = 0; i < elems.length; i++) {
          const r = this.validateValue(value[i], elems[i]);
          if (r === NO_MATCH) return NO_MATCH;
          out.push(r);
        }
        return out;
      }
      case K_RECORD: {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_MATCH;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as object)) {
          const r = this.validateValue((value as Record<string, unknown>)[key], (schema as RecordSchema).elem);
          if (r === NO_MATCH) return NO_MATCH;
          out[key] = r;
        }
        return out;
      }
      case K_OBJ: {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_MATCH;
        const s = schema as ObjSchema;
        const obj = value as Record<string, unknown>;
        const n = s.n;
        const present: boolean[] = new Array(n);
        const values: unknown[] = new Array(n);
        for (let i = 0; i < n; i++) present[i] = false;
        for (const key of Object.keys(obj)) {      // own keys: the plain parse made the object
          const i = s.index.get(key);
          if (i === undefined) continue;
          const r = this.validateValue(obj[key], s.schemas[i]);
          if (r === NO_MATCH) return NO_MATCH;
          present[i] = true; values[i] = r;
        }
        const out: unknown[] = [];
        let mask = 0;
        for (let i = 0; i < n; i++) {
          if (present[i]) { out.push(values[i]); if (s.narrow) mask |= (1 << i); }
          else if (!s.optional[i]) return NO_MATCH;
        }
        return this.makeObject(s.narrow ? s.layoutFor(mask) : s.layoutForWide(present), out);
      }
      case K_UNION: {
        for (const m of (schema as UnionSchema).members) {
          const r = this.validateValue(value, m);
          if (r !== NO_MATCH) return r;
        }
        return NO_MATCH;
      }
    }
    return NO_MATCH;
  }
}

/** The generic parse and stringify (the module that exports `JSON` cannot name the global). */
export function parseGeneric(text: string): unknown { return JSON.parse(text); }
export function stringifyGeneric(value: unknown): string { return JSON.stringify(value); }

/** Parse `text` as a value of `schema`. */
export function parseText(text: string, schema: Schema, makeObject: MakeObject): unknown {
  const p = new Parser(text, makeObject);
  const v = p.parseValue(schema);
  p.skipWs();
  if (p.pos !== text.length) p.fail("unexpected trailing characters");
  return v;
}
