/**
 * SROA — Scalar Replacement of Aggregates + method/ctor inlining.
 * The TypeScript port of analyzer/src/sroa.rs (faithful, including the
 * conservative disqualification rules; over-disqualifying only forgoes an
 * optimization, it never miscompiles).
 *
 * Object SROA: a `new C()` whose instance is NoEscape and used only as the
 * receiver of Direct calls to C's own methods/ctor is eliminated — one scalar
 * local per field, methods/ctor inlined (`this.fK` -> scalar, params -> args,
 * tail `Return x` -> `Copy dst, x`).
 * Array SROA (per body): a local `[...]` with only constant-index reads/writes
 * is replaced by per-index scalars + a tracked constant length.
 * Free-function inlining: tiny straight-line callees are spliced in.
 *
 * Validation: `main.ts <ir> sroa` dumps the post-SROA IR; compared byte-for-
 * byte against the Rust `tsaot <ir> sroa` across the conformance corpus.
 */
import { Program } from "./ir";
import { EscapeResult } from "./interproc";

type Inst = any;
interface FnT {
  id: number;
  params: number[];
  locals: any[];
  body: Inst[];
  isGenerator?: boolean;
  isAsync?: boolean;
}

// ----------------------------- small helpers --------------------------------

/** Deep clone of a JSON-shaped value (objects/arrays/primitives). Equivalent to
 *  JSON.parse(JSON.stringify(v)) for IR data, without the runtime stringify
 *  depth guard tripping on deeply nested instruction trees. */
function deepCloneJson(v: any): any {
  if (Array.isArray(v)) {
    const out: any[] = [];
    for (const x of v) out.push(deepCloneJson(x));
    return out;
  }
  if (v !== null && typeof v === "object") {
    const out: any = {};
    for (const k of Object.keys(v)) out[k] = deepCloneJson(v[k]);
    return out;
  }
  return v;
}

function freshLocal(st: { next: number; newLocals: any[] }, reference: boolean): number {
  const id = st.next;
  st.next++;
  st.newLocals.push({
    id,
    typeId: 0,
    refKind: reference ? "reference" : "primitive",
    binding: null,
    name: null,
    nullableNumeric: false,
  });
  return id;
}

function resolveAliasRoot(id: number, alias: Map<number, number>): number {
  let cur = id;
  let seen = 0;
  for (;;) {
    const s = alias.get(cur);
    if (s === undefined) break;
    cur = s;
    seen++;
    if (seen > 64) break;
  }
  return cur;
}

function constArrayIndexValue(value: any): number | undefined {
  if (value && value.kind === "Num") {
    const v = value.value;
    if (Number.isFinite(v) && v >= 0 && Number.isInteger(v) && v < 4294967295) return v;
  }
  return undefined;
}

function constIsNumberValue(value: any): boolean {
  if (!value) return false;
  const k = value.kind;
  return k === "Num" || k === "NaN" || k === "PosInf" || k === "NegInf" || k === "NegZero";
}

const NUM_BINOPS = new Set(["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>"]);
const NUM_UNOPS = new Set(["+", "-", "~"]);

function collectNumberLocs(body: Inst[]): Set<number> {
  const numeric = new Set<number>();
  const st = { changed: true };
  while (st.changed) {
    st.changed = false;
    collectNumberLocsPass(body, numeric, st);
  }
  return numeric;
}

function collectNumberLocsPass(body: Inst[], numeric: Set<number>, st: { changed: boolean }): void {
  for (const inst of body) {
    let def: [number, boolean] | undefined;
    switch (inst.kind) {
      case "Const":
        def = [inst.dst, constIsNumberValue(inst.value)];
        break;
      case "Copy":
        def = [inst.dst, numeric.has(inst.src)];
        break;
      case "UnOp":
        def = [inst.dst, NUM_UNOPS.has(inst.op) && numeric.has(inst.operand)];
        break;
      case "BinOp":
        def = [inst.dst, NUM_BINOPS.has(inst.op) && numeric.has(inst.lhs) && numeric.has(inst.rhs)];
        break;
      case "ArrayLen":
      case "StringLen":
      case "GenericLen":
        def = [inst.dst, true];
        break;
      case "Loop":
        collectNumberLocsPass(inst.condBody ?? [], numeric, st);
        collectNumberLocsPass(inst.body ?? [], numeric, st);
        break;
      case "If":
        collectNumberLocsPass(inst.thenBody ?? [], numeric, st);
        collectNumberLocsPass(inst.elseBody ?? [], numeric, st);
        break;
      case "TryCatch":
        collectNumberLocsPass(inst.tryBody ?? [], numeric, st);
        collectNumberLocsPass(inst.catchBody ?? [], numeric, st);
        collectNumberLocsPass(inst.finallyBody ?? [], numeric, st);
        break;
      default:
        break;
    }
    if (def !== undefined && def[1] && !numeric.has(def[0])) {
      numeric.add(def[0]);
      st.changed = true;
    }
  }
}

// ------------------------- operand remap (exhaustive) ------------------------

/** Clone an Inst remapping every LocalId operand through `m`. MUST be
 *  exhaustive: an unhandled variant emitted with original ids silently reads
 *  the caller's wrong locals. Unknown kinds throw loudly. */
function remapInstOperands(inst: Inst, m: (l: number) => number): Inst {
  const mv = (b: Inst[]) => b.map((i) => remapInstOperands(i, m));
  const mo = (o: number | null | undefined) => (o === null || o === undefined ? o : m(o));
  const mcallee = (c: any) => (c && c.kind === "Value" ? { ...c, local: m(c.local) } : c);
  switch (inst.kind) {
    case "Const": return { ...inst, dst: m(inst.dst) };
    case "BinOp": return { ...inst, dst: m(inst.dst), lhs: m(inst.lhs), rhs: m(inst.rhs) };
    case "UnOp": return { ...inst, dst: m(inst.dst), operand: m(inst.operand) };
    case "Copy": return { ...inst, dst: m(inst.dst), src: m(inst.src) };
    case "LoadField": return { ...inst, dst: m(inst.dst), obj: m(inst.obj) };
    case "StoreField": return { ...inst, obj: m(inst.obj), src: m(inst.src) };
    case "LoadMethodValue": return { ...inst, dst: m(inst.dst), recv: m(inst.recv) };
    case "LoadBuiltinFn": return { ...inst, dst: m(inst.dst) };
    case "AllocClassValue":
      return { ...inst, dst: m(inst.dst), captures: (inst.captures ?? []).map((c: any) => ({ ...c, cell: m(c.cell) })) };
    case "NewDynamic":
      return { ...inst, dst: m(inst.dst), callee: m(inst.callee), args: (inst.args ?? []).map(m) };
    case "AllocObject":
      return { ...inst, dst: m(inst.dst), proto: mo(inst.proto) };
    case "AllocArray": return { ...inst, dst: m(inst.dst) };
    case "AllocClosure":
      return { ...inst, dst: m(inst.dst), captures: (inst.captures ?? []).map((c: any) => ({ ...c, cell: m(c.cell) })) };
    case "LoadElem": return { ...inst, dst: m(inst.dst), arr: m(inst.arr) };
    case "StoreElem": return { ...inst, arr: m(inst.arr), src: m(inst.src) };
    case "LoadIndex": return { ...inst, dst: m(inst.dst), arr: m(inst.arr), index: m(inst.index) };
    case "StoreIndex": return { ...inst, arr: m(inst.arr), index: m(inst.index), src: m(inst.src) };
    case "LoadGlobal": return { ...inst, dst: m(inst.dst) };
    case "StoreGlobal": return { ...inst, src: m(inst.src) };
    case "LoadFieldDynamic": return { ...inst, dst: m(inst.dst), obj: m(inst.obj), key: m(inst.key) };
    case "StoreFieldDynamic": return { ...inst, obj: m(inst.obj), key: m(inst.key), src: m(inst.src) };
    case "HasField": return { ...inst, dst: m(inst.dst), obj: m(inst.obj) };
    case "HasFieldDynamic": return { ...inst, dst: m(inst.dst), obj: m(inst.obj), key: m(inst.key) };
    case "DeleteField": return { ...inst, dst: mo(inst.dst), obj: m(inst.obj) };
    case "Call":
      return { ...inst, dst: mo(inst.dst), callee: mcallee(inst.callee), recv: mo(inst.recv), args: (inst.args ?? []).map(m) };
    case "CallSpread":
      return {
        ...inst, dst: mo(inst.dst), callee: mcallee(inst.callee), recv: mo(inst.recv),
        argSpecs: (inst.argSpecs ?? []).map((s: any) => ({ ...s, local: m(s.local) })),
      };
    case "CallBuiltin":
      return { ...inst, dst: mo(inst.dst), recv: m(inst.recv), args: (inst.args ?? []).map(m) };
    case "CallBuiltinStatic":
      return { ...inst, dst: mo(inst.dst), args: (inst.args ?? []).map(m) };
    case "ArrayLen": return { ...inst, dst: m(inst.dst), arr: m(inst.arr) };
    case "StringLen": return { ...inst, dst: m(inst.dst), src: m(inst.src) };
    case "ArrayPush": return { ...inst, arr: m(inst.arr), src: m(inst.src) };
    case "ArrayPushAll": return { ...inst, arr: m(inst.arr), src: m(inst.src) };
    case "ArraySlice": return { ...inst, dst: m(inst.dst), arr: m(inst.arr), start: m(inst.start) };
    case "ObjectRest": return { ...inst, dst: m(inst.dst), src: m(inst.src) };
    case "ObjectCopyProps": return { ...inst, dst: m(inst.dst), src: m(inst.src) };
    case "NewMap": return { ...inst, dst: m(inst.dst) };
    case "NewSet": return { ...inst, dst: m(inst.dst) };
    case "GenericLen": return { ...inst, dst: m(inst.dst), src: m(inst.src) };
    case "LoadClassProto": return { ...inst, dst: m(inst.dst) };
    case "StoreProtoMethod": return { ...inst, src: m(inst.src) };
    case "StoreMethod": return { ...inst, obj: m(inst.obj), src: m(inst.src) };
    case "GetProto": return { ...inst, dst: m(inst.dst), obj: m(inst.obj) };
    case "SetProto": return { ...inst, dst: mo(inst.dst), obj: m(inst.obj), proto: m(inst.proto) };
    case "ConstructResult": return { ...inst, dst: m(inst.dst), inst: m(inst.inst), ret: m(inst.ret) };
    case "Print": return { ...inst, src: m(inst.src) };
    case "Return": return { ...inst, src: mo(inst.src) };
    case "Throw": return { ...inst, src: m(inst.src) };
    case "Yield": return { ...inst, dst: mo(inst.dst), operand: m(inst.operand) };
    case "Await": return { ...inst, dst: mo(inst.dst), operand: m(inst.operand) };
    case "If":
      return { ...inst, cond: m(inst.cond), thenBody: mv(inst.thenBody ?? []), elseBody: mv(inst.elseBody ?? []) };
    case "Loop":
      return { ...inst, cond: m(inst.cond), condBody: mv(inst.condBody ?? []), body: mv(inst.body ?? []) };
    case "TryCatch":
      return {
        ...inst, tryBody: mv(inst.tryBody ?? []), catchVar: mo(inst.catchVar),
        catchBody: mv(inst.catchBody ?? []), finallyBody: mv(inst.finallyBody ?? []),
      };
    case "Break":
    case "Continue":
      return inst;
    default:
      throw new Error(`sroa remap: unclassified instruction kind '${inst.kind}'`);
  }
}

/** Collect every local referenced (any operand, nested bodies included). */
function collectLocalRefs(body: Inst[], set: Set<number>): void {
  for (const inst of body) {
    remapInstOperands(inst, (l) => {
      set.add(l);
      return l;
    });
  }
}

// ------------------------------ array SROA ----------------------------------

interface ArraySroaTarget {
  indices: Set<number>;
  numericIndices: Set<number>;
}

function arrayRootForTarget(id: number, targets: Map<number, ArraySroaTarget>, alias: Map<number, number>): number | undefined {
  const root = resolveAliasRoot(id, alias);
  return targets.has(root) ? root : undefined;
}

function arrayRootForScalars(id: number, scalars: Map<number, Map<number, number>>, alias: Map<number, number>): number | undefined {
  const root = resolveAliasRoot(id, alias);
  return scalars.has(root) ? root : undefined;
}

function invalidateArrayTrackingDef(id: number, arrayAlias: Map<number, number>, constIndices: Map<number, number>): void {
  arrayAlias.delete(id);
  constIndices.delete(id);
}

function invalidateArrayTrackingDefs(inst: Inst, arrayAlias: Map<number, number>, constIndices: Map<number, number>): void {
  const kill = (id: number) => invalidateArrayTrackingDef(id, arrayAlias, constIndices);
  switch (inst.kind) {
    case "AllocObject": case "AllocArray": case "AllocClosure": case "Copy":
    case "LoadField": case "LoadMethodValue": case "LoadBuiltinFn": case "AllocClassValue":
    case "NewDynamic": case "LoadElem": case "LoadGlobal": case "Const": case "BinOp":
    case "UnOp": case "LoadIndex": case "ArrayLen": case "StringLen": case "HasField":
    case "HasFieldDynamic": case "GenericLen": case "LoadFieldDynamic": case "ArraySlice":
    case "ObjectRest": case "ObjectCopyProps": case "ConstructResult": case "LoadClassProto":
    case "GetProto": case "NewMap": case "NewSet":
      kill(inst.dst);
      break;
    case "Call": case "Yield": case "Await": case "CallSpread": case "CallBuiltin":
    case "CallBuiltinStatic": case "DeleteField": case "SetProto":
      if (inst.dst !== undefined && inst.dst !== null) kill(inst.dst);
      break;
    case "TryCatch":
      if (inst.catchVar !== undefined && inst.catchVar !== null) kill(inst.catchVar);
      break;
    default:
      break; // stores / control flow: no defs
  }
}

function disqualifyArrayRootsInInst(inst: Inst, targets: Map<number, ArraySroaTarget>, alias: Map<number, number>, disq: Set<number>): void {
  const l = (id: number) => {
    const root = arrayRootForTarget(id, targets, alias);
    if (root !== undefined) disq.add(root);
  };
  const body = (insts: Inst[]) => {
    for (const i of insts) disqualifyArrayRootsInInst(i, targets, alias, disq);
  };
  switch (inst.kind) {
    case "AllocObject":
      l(inst.dst);
      if (inst.proto !== undefined && inst.proto !== null) l(inst.proto);
      break;
    case "AllocArray": case "LoadBuiltinFn": case "LoadGlobal": case "Const":
    case "NewMap": case "NewSet": case "LoadClassProto":
      l(inst.dst);
      break;
    case "AllocClosure": case "AllocClassValue":
      l(inst.dst);
      for (const c of inst.captures ?? []) l(c.cell);
      break;
    case "Copy":
      l(inst.dst); l(inst.src);
      break;
    case "LoadField": l(inst.dst); l(inst.obj); break;
    case "LoadElem": l(inst.dst); l(inst.arr); break;
    case "ArrayLen": l(inst.dst); l(inst.arr); break;
    case "StringLen": l(inst.dst); l(inst.src); break;
    case "HasField": l(inst.dst); l(inst.obj); break;
    case "GenericLen": l(inst.dst); l(inst.src); break;
    case "GetProto": l(inst.dst); l(inst.obj); break;
    case "StoreField": l(inst.obj); l(inst.src); break;
    case "StoreElem": l(inst.arr); l(inst.src); break;
    case "StoreGlobal": case "StoreProtoMethod": l(inst.src); break;
    case "LoadMethodValue": l(inst.dst); l(inst.recv); break;
    case "NewDynamic":
      l(inst.dst); l(inst.callee);
      for (const a of inst.args ?? []) l(a);
      break;
    case "Call":
      if (inst.dst !== undefined && inst.dst !== null) l(inst.dst);
      if (inst.recv !== undefined && inst.recv !== null) l(inst.recv);
      for (const a of inst.args ?? []) l(a);
      break;
    case "Return":
      if (inst.src !== undefined && inst.src !== null) l(inst.src);
      break;
    case "Yield": case "Await":
      if (inst.dst !== undefined && inst.dst !== null) l(inst.dst);
      l(inst.operand);
      break;
    case "Throw": case "Print": l(inst.src); break;
    case "TryCatch":
      body(inst.tryBody ?? []);
      if (inst.catchVar !== undefined && inst.catchVar !== null) l(inst.catchVar);
      body(inst.catchBody ?? []);
      body(inst.finallyBody ?? []);
      break;
    case "BinOp": l(inst.dst); l(inst.lhs); l(inst.rhs); break;
    case "UnOp": l(inst.dst); l(inst.operand); break;
    case "LoadIndex": l(inst.dst); l(inst.arr); l(inst.index); break;
    case "StoreIndex": l(inst.arr); l(inst.index); l(inst.src); break;
    case "ArrayPush": case "ArrayPushAll": l(inst.arr); l(inst.src); break;
    case "HasFieldDynamic": case "LoadFieldDynamic": l(inst.dst); l(inst.obj); l(inst.key); break;
    case "StoreFieldDynamic": l(inst.obj); l(inst.key); l(inst.src); break;
    case "DeleteField":
      if (inst.dst !== undefined && inst.dst !== null) l(inst.dst);
      l(inst.obj);
      break;
    case "ArraySlice": l(inst.dst); l(inst.arr); l(inst.start); break;
    case "ObjectRest": case "ObjectCopyProps": l(inst.dst); l(inst.src); break;
    case "ConstructResult": l(inst.dst); l(inst.inst); l(inst.ret); break;
    case "CallSpread":
      if (inst.dst !== undefined && inst.dst !== null) l(inst.dst);
      if (inst.recv !== undefined && inst.recv !== null) l(inst.recv);
      for (const s of inst.argSpecs ?? []) l(s.local);
      break;
    case "StoreMethod": l(inst.obj); l(inst.src); break;
    case "SetProto":
      if (inst.dst !== undefined && inst.dst !== null) l(inst.dst);
      l(inst.obj); l(inst.proto);
      break;
    case "CallBuiltin":
      if (inst.dst !== undefined && inst.dst !== null) l(inst.dst);
      l(inst.recv);
      for (const a of inst.args ?? []) l(a);
      break;
    case "CallBuiltinStatic":
      if (inst.dst !== undefined && inst.dst !== null) l(inst.dst);
      for (const a of inst.args ?? []) l(a);
      break;
    case "If":
      l(inst.cond);
      body(inst.thenBody ?? []);
      body(inst.elseBody ?? []);
      break;
    case "Loop":
      l(inst.cond);
      body(inst.condBody ?? []);
      body(inst.body ?? []);
      break;
    case "Break": case "Continue":
      break;
    default:
      throw new Error(`sroa disqualify: unclassified instruction kind '${inst.kind}'`);
  }
}

function findArraySroaTargets(body: Inst[], numberLocs: Set<number>, outside: Set<number>): Map<number, ArraySroaTarget> {
  const targets = new Map<number, ArraySroaTarget>();
  const disq = new Set<number>();
  const alias = new Map<number, number>();
  const constIndices = new Map<number, number>();
  const currentNumeric = new Map<string, boolean>(); // `${root},${idx}`
  const allStoresNumeric = new Map<string, boolean>();
  const readsNumeric = new Map<string, boolean>();

  const disqLocal = (id: number) => {
    const root = arrayRootForTarget(id, targets, alias);
    if (root !== undefined) disq.add(root);
  };

  for (const inst of body) {
    switch (inst.kind) {
      case "AllocArray":
        alias.delete(inst.dst);
        constIndices.delete(inst.dst);
        targets.set(inst.dst, { indices: new Set(), numericIndices: new Set() });
        break;
      case "Const": {
        alias.delete(inst.dst);
        constIndices.delete(inst.dst);
        if (targets.has(inst.dst)) disq.add(inst.dst);
        const idx = constArrayIndexValue(inst.value);
        if (idx !== undefined) constIndices.set(inst.dst, idx);
        break;
      }
      case "Copy": {
        const copiedConst = constIndices.get(inst.src);
        alias.delete(inst.dst);
        constIndices.delete(inst.dst);
        if (targets.has(inst.dst)) disq.add(inst.dst);
        if (copiedConst !== undefined) constIndices.set(inst.dst, copiedConst);
        const root = arrayRootForTarget(inst.src, targets, alias);
        if (root !== undefined) alias.set(inst.dst, root);
        break;
      }
      case "StoreIndex": {
        const root = arrayRootForTarget(inst.arr, targets, alias);
        if (root !== undefined) {
          const idx = constIndices.get(inst.index);
          if (idx === undefined) {
            disq.add(root);
          } else {
            const isNum = numberLocs.has(inst.src);
            const k = `${root},${idx}`;
            currentNumeric.set(k, isNum);
            allStoresNumeric.set(k, (allStoresNumeric.get(k) ?? true) && isNum);
          }
        }
        disqLocal(inst.index);
        disqLocal(inst.src);
        break;
      }
      case "LoadIndex": {
        alias.delete(inst.dst);
        constIndices.delete(inst.dst);
        if (targets.has(inst.dst)) disq.add(inst.dst);
        const root = arrayRootForTarget(inst.arr, targets, alias);
        if (root !== undefined) {
          const idx = constIndices.get(inst.index);
          if (idx !== undefined) {
            targets.get(root)!.indices.add(idx);
            const k = `${root},${idx}`;
            const isNum = currentNumeric.get(k) ?? false;
            readsNumeric.set(k, (readsNumeric.get(k) ?? true) && isNum);
          } else {
            disq.add(root);
          }
        }
        disqLocal(inst.index);
        break;
      }
      case "StoreFieldDynamic": {
        const root = arrayRootForTarget(inst.obj, targets, alias);
        if (root !== undefined) {
          const idx = constIndices.get(inst.key);
          if (idx === undefined) {
            disq.add(root);
          } else {
            const isNum = numberLocs.has(inst.src);
            const k = `${root},${idx}`;
            currentNumeric.set(k, isNum);
            allStoresNumeric.set(k, (allStoresNumeric.get(k) ?? true) && isNum);
          }
        }
        disqLocal(inst.key);
        disqLocal(inst.src);
        break;
      }
      case "LoadFieldDynamic": {
        alias.delete(inst.dst);
        constIndices.delete(inst.dst);
        if (targets.has(inst.dst)) disq.add(inst.dst);
        const root = arrayRootForTarget(inst.obj, targets, alias);
        if (root !== undefined) {
          const idx = constIndices.get(inst.key);
          if (idx !== undefined) {
            targets.get(root)!.indices.add(idx);
            const k = `${root},${idx}`;
            const isNum = currentNumeric.get(k) ?? false;
            readsNumeric.set(k, (readsNumeric.get(k) ?? true) && isNum);
          } else {
            disq.add(root);
          }
        }
        disqLocal(inst.key);
        break;
      }
      case "ArrayLen": {
        alias.delete(inst.dst);
        constIndices.delete(inst.dst);
        if (targets.has(inst.dst)) disq.add(inst.dst);
        if (arrayRootForTarget(inst.arr, targets, alias) === undefined) {
          disqLocal(inst.arr);
        }
        break;
      }
      case "StringLen": {
        alias.delete(inst.dst);
        constIndices.delete(inst.dst);
        if (targets.has(inst.dst)) disq.add(inst.dst);
        disqLocal(inst.src);
        break;
      }
      case "ArrayPush":
      case "ArrayPushAll":
        disqLocal(inst.arr);
        disqLocal(inst.src);
        break;
      case "If":
      case "Loop":
      case "TryCatch":
        for (const root of targets.keys()) disq.add(root);
        disqualifyArrayRootsInInst(inst, targets, alias, disq);
        invalidateArrayTrackingDefs(inst, alias, constIndices);
        break;
      default:
        disqualifyArrayRootsInInst(inst, targets, alias, disq);
        invalidateArrayTrackingDefs(inst, alias, constIndices);
        break;
    }
  }

  for (const [dst, root] of alias) {
    if (outside.has(dst)) disq.add(root);
  }
  for (const r of targets.keys()) {
    if (outside.has(r)) disq.add(r);
  }

  const filtered = new Map<number, ArraySroaTarget>();
  for (const [root, target] of targets) {
    if (!disq.has(root)) {
      for (const idx of target.indices) {
        const k = `${root},${idx}`;
        if ((readsNumeric.get(k) ?? false) && (allStoresNumeric.get(k) ?? false)) {
          target.numericIndices.add(idx);
        }
      }
      filtered.set(root, target);
    }
  }
  return filtered;
}

// ------------------------------ object SROA ---------------------------------

/** True if `f` returns its receiver (param 0), directly or via a copy. */
function returnsReceiver(f: FnT): boolean {
  if (f.params.length === 0) return false;
  const aliases = new Set<number>([f.params[0]]);
  const gather = (body: Inst[]) => {
    for (const inst of body) {
      if (inst.kind === "Copy" && aliases.has(inst.src)) aliases.add(inst.dst);
      else if (inst.kind === "Loop") { gather(inst.condBody ?? []); gather(inst.body ?? []); }
      else if (inst.kind === "If") { gather(inst.thenBody ?? []); gather(inst.elseBody ?? []); }
      else if (inst.kind === "TryCatch") { gather(inst.tryBody ?? []); gather(inst.catchBody ?? []); gather(inst.finallyBody ?? []); }
    }
  };
  gather(f.body);
  const returns = (body: Inst[]): boolean => {
    for (const inst of body) {
      if (inst.kind === "Return" && inst.src !== undefined && inst.src !== null && aliases.has(inst.src)) return true;
      if (inst.kind === "Loop" && (returns(inst.condBody ?? []) || returns(inst.body ?? []))) return true;
      if (inst.kind === "If" && (returns(inst.thenBody ?? []) || returns(inst.elseBody ?? []))) return true;
      if (inst.kind === "TryCatch" && (returns(inst.tryBody ?? []) || returns(inst.catchBody ?? []) || returns(inst.finallyBody ?? []))) return true;
    }
    return false;
  };
  return returns(f.body);
}

/** Does `f` capture `this` (param 0) into a closure? (StoreField src==this AND
 *  any AllocClosure — the lexical-this-cell pattern; conservative.) */
function capturesThis(f: FnT): boolean {
  if (f.params.length === 0) return false;
  const thisLocal = f.params[0];
  const st = { storesThis: false, hasClosure: false };
  const scan = (body: Inst[]) => {
    for (const inst of body) {
      if (inst.kind === "StoreField" && inst.src === thisLocal) st.storesThis = true;
      else if (inst.kind === "AllocClosure") st.hasClosure = true;
      else if (inst.kind === "Loop") { scan(inst.condBody ?? []); scan(inst.body ?? []); }
      else if (inst.kind === "If") { scan(inst.thenBody ?? []); scan(inst.elseBody ?? []); }
      else if (inst.kind === "TryCatch") { scan(inst.tryBody ?? []); scan(inst.catchBody ?? []); scan(inst.finallyBody ?? []); }
    }
  };
  scan(f.body);
  return st.storesThis && st.hasClosure;
}

/** True if `f` needs a materialized `this`: generator/async, dynamic access on
 *  param0, or a transitive Direct call on its own receiver to such a method. */
function needsMaterializedThis(f: FnT, bodies: Map<number, FnT>, depth: number): boolean {
  if (f.isGenerator || f.isAsync) return true;
  if (depth > 16) return true;
  if (f.params.length === 0) return false;
  const p0 = f.params[0];
  const scan = (body: Inst[]): boolean => {
    for (const inst of body) {
      if ((inst.kind === "LoadFieldDynamic" || inst.kind === "StoreFieldDynamic" || inst.kind === "HasFieldDynamic") && inst.obj === p0) return true;
      if (inst.kind === "DeleteField" && inst.obj === p0) return true;
      if (inst.kind === "Call" && inst.recv === p0 && inst.callee?.kind === "Direct") {
        const cf = bodies.get(inst.callee.func);
        if (cf !== undefined && needsMaterializedThis(cf, bodies, depth + 1)) return true;
      }
      if (inst.kind === "Loop" && (scan(inst.condBody ?? []) || scan(inst.body ?? []))) return true;
      if (inst.kind === "If" && (scan(inst.thenBody ?? []) || scan(inst.elseBody ?? []))) return true;
      if (inst.kind === "TryCatch" && (scan(inst.tryBody ?? []) || scan(inst.catchBody ?? []) || scan(inst.finallyBody ?? []))) return true;
    }
    return false;
  };
  return scan(f.body);
}

function calleeTouchesParam0Fields(f: FnT): boolean {
  if (f.params.length === 0) return false;
  const p0 = f.params[0];
  return f.body.some((inst) =>
    (inst.kind === "LoadField" && inst.obj === p0) || (inst.kind === "StoreField" && inst.obj === p0)
  );
}

function calleeParamFieldOnlySroaSafe(f: FnT, paramIndex: number, classFields: number[]): boolean {
  if (paramIndex >= f.params.length) return false;
  const p = f.params[paramIndex];
  const fieldOk = (field: number) => classFields.some((x) => x === field);
  for (const inst of f.body) {
    switch (inst.kind) {
      case "LoadField":
        if (inst.dst === p) return false;
        if (inst.obj === p && !fieldOk(inst.field)) return false;
        break;
      case "StoreField":
        if (inst.src === p) return false;
        if (inst.obj === p && !fieldOk(inst.field)) return false;
        break;
      case "Const":
        if (inst.dst === p) return false;
        break;
      case "BinOp":
        if (inst.dst === p || inst.lhs === p || inst.rhs === p) return false;
        break;
      case "UnOp":
        if (inst.dst === p || inst.operand === p) return false;
        break;
      case "Copy":
        if (inst.dst === p || inst.src === p) return false;
        break;
      case "Return":
        if (inst.src !== undefined && inst.src !== null && inst.src === p) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Only Return (if any) is the body's final top-level instruction. */
function returnsOnlyInTailPosition(f: FnT): boolean {
  const nestedHasReturn = (insts: Inst[]): boolean => {
    for (const inst of insts) {
      if (inst.kind === "Return") return true;
      if (inst.kind === "If" && (nestedHasReturn(inst.thenBody ?? []) || nestedHasReturn(inst.elseBody ?? []))) return true;
      if (inst.kind === "Loop" && (nestedHasReturn(inst.condBody ?? []) || nestedHasReturn(inst.body ?? []))) return true;
      if (inst.kind === "TryCatch" && (nestedHasReturn(inst.tryBody ?? []) || nestedHasReturn(inst.catchBody ?? []) || nestedHasReturn(inst.finallyBody ?? []))) return true;
    }
    return false;
  };
  const n = f.body.length;
  for (let i = 0; i < n; i++) {
    const inst = f.body[i];
    if (inst.kind === "Return") {
      if (i !== n - 1) return false;
    } else if (inst.kind === "If") {
      if (nestedHasReturn(inst.thenBody ?? []) || nestedHasReturn(inst.elseBody ?? [])) return false;
    } else if (inst.kind === "Loop") {
      if (nestedHasReturn(inst.condBody ?? []) || nestedHasReturn(inst.body ?? [])) return false;
    } else if (inst.kind === "TryCatch") {
      if (nestedHasReturn(inst.tryBody ?? []) || nestedHasReturn(inst.catchBody ?? []) || nestedHasReturn(inst.finallyBody ?? [])) return false;
    }
  }
  return true;
}

function isInlinableFreeFn(f: FnT): boolean {
  if (f.isGenerator || f.isAsync) return false;
  const MAX_BODY = 8;
  if (f.body.length > MAX_BODY) return false;
  const isParam = (id: number) => f.params.some((p) => p === id);
  let returns = 0;
  for (let i = 0; i < f.body.length; i++) {
    const inst = f.body[i];
    switch (inst.kind) {
      case "Const": case "BinOp": case "UnOp": case "Copy": case "LoadField":
        if (isParam(inst.dst)) return false;
        break;
      case "StoreField":
        break;
      case "Return":
        returns++;
        if (i !== f.body.length - 1) return false;
        break;
      default:
        return false;
    }
  }
  return returns <= 1;
}

/** Find SROA-qualified receivers: alloc'd here at a NoEscape site with a known
 *  class, used only as Direct-call receivers / safe copies. recv -> class. */
function findSroaTargets(
  body: Inst[],
  noescape: Set<number>,
  classFields: Map<number, number[]>,
  bodies: Map<number, FnT>
): Map<number, number> {
  const allocClass = new Map<number, number>();
  const disq = new Set<number>();
  const alias = new Map<number, number>();

  const scan = (body: Inst[]) => {
    for (const inst of body) {
      switch (inst.kind) {
        case "AllocObject":
          if (inst.classId !== undefined && inst.classId !== null) {
            if (noescape.has(inst.site)) allocClass.set(inst.dst, inst.classId);
            else disq.add(inst.dst);
          } else {
            // class-less alloc: dst handled by the generic operand walk? Rust
            // matches only class_id=Some here; class-less AllocObject falls to
            // the `_ => {}` arm (no disqualification of dst itself).
          }
          break;
        case "NewDynamic":
          disq.add(inst.dst);
          break;
        case "Copy":
          alias.set(inst.dst, inst.src);
          break;
        case "Call": {
          if (inst.recv !== undefined && inst.recv !== null) {
            if (inst.callee?.kind === "Direct") {
              const calleeFn = bodies.get(inst.callee.func);
              if (calleeFn !== undefined) {
                if (capturesThis(calleeFn) || returnsReceiver(calleeFn) || needsMaterializedThis(calleeFn, bodies, 0)) {
                  disq.add(inst.recv);
                }
              }
            } else {
              disq.add(inst.recv);
            }
          }
          const args: number[] = inst.args ?? [];
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            const ra = resolveAliasRoot(a, alias);
            let passIsSroaSafe = false;
            if ((inst.recv === undefined || inst.recv === null) && inst.callee?.kind === "Direct") {
              const cls = allocClass.get(ra);
              if (cls !== undefined) {
                const calleeFn = bodies.get(inst.callee.func);
                const fields = classFields.get(cls);
                if (calleeFn !== undefined && fields !== undefined) {
                  passIsSroaSafe = isInlinableFreeFn(calleeFn) && calleeParamFieldOnlySroaSafe(calleeFn, i, fields);
                }
              }
            }
            if (!passIsSroaSafe) {
              disq.add(a);
              disq.add(ra);
            }
          }
          break;
        }
        case "StoreField": disq.add(inst.src); break;
        case "StoreGlobal": disq.add(inst.src); break;
        case "StoreElem": disq.add(inst.src); break;
        case "Return":
          if (inst.src !== undefined && inst.src !== null) disq.add(inst.src);
          break;
        case "Throw": disq.add(inst.src); break;
        case "LoadField": {
          const robj = resolveAliasRoot(inst.obj, alias);
          const cls = allocClass.get(robj);
          if (cls !== undefined) {
            const fields = classFields.get(cls);
            const isDeclared = fields !== undefined && fields.some((f) => f === inst.field);
            if (!isDeclared) disq.add(robj);
          }
          break;
        }
        case "BinOp": disq.add(inst.lhs); disq.add(inst.rhs); break;
        case "UnOp": disq.add(inst.operand); break;
        case "LoadIndex": disq.add(inst.arr); disq.add(inst.index); break;
        case "StoreIndex": disq.add(inst.arr); disq.add(inst.index); disq.add(inst.src); break;
        case "ArrayLen": disq.add(inst.arr); break;
        case "StringLen": disq.add(inst.src); break;
        case "ArrayPush": disq.add(inst.arr); disq.add(inst.src); break;
        case "ArrayPushAll": disq.add(inst.arr); disq.add(inst.src); break;
        case "ArraySlice": disq.add(inst.arr); disq.add(inst.start); break;
        case "HasField": disq.add(inst.obj); break;
        case "HasFieldDynamic": disq.add(inst.obj); disq.add(inst.key); break;
        case "GenericLen": disq.add(inst.src); break;
        case "LoadFieldDynamic": disq.add(inst.obj); disq.add(inst.key); break;
        case "StoreFieldDynamic": disq.add(inst.obj); disq.add(inst.key); disq.add(inst.src); break;
        case "DeleteField": disq.add(inst.obj); break;
        case "ObjectRest": disq.add(inst.src); break;
        case "ObjectCopyProps": disq.add(inst.src); break;
        case "ConstructResult": disq.add(inst.inst); disq.add(inst.ret); break;
        case "GetProto": disq.add(inst.obj); break;
        case "SetProto": disq.add(inst.obj); disq.add(inst.proto); break;
        case "StoreProtoMethod": case "StoreMethod": disq.add(inst.src); break;
        case "Print": disq.add(inst.src); break;
        case "CallBuiltin":
          disq.add(inst.recv);
          for (const a of inst.args ?? []) disq.add(a);
          break;
        case "CallBuiltinStatic":
          for (const a of inst.args ?? []) disq.add(a);
          break;
        case "CallSpread":
          if (inst.recv !== undefined && inst.recv !== null) disq.add(inst.recv);
          for (const s of inst.argSpecs ?? []) disq.add(s.local);
          break;
        case "Loop":
          disq.add(inst.cond);
          scan(inst.condBody ?? []);
          scan(inst.body ?? []);
          break;
        case "If":
          disq.add(inst.cond);
          scan(inst.thenBody ?? []);
          scan(inst.elseBody ?? []);
          break;
        default:
          break;
      }
    }
  };
  scan(body);

  const out = new Map<number, number>();
  for (const [r, c] of allocClass) {
    if (!disq.has(r)) {
      let aliasDisq = false;
      for (const [d, s] of alias) {
        if (s === r && disq.has(d)) {
          aliasDisq = true;
          break;
        }
      }
      if (!aliasDisq) out.set(r, c);
    }
  }
  return out;
}

// -------------------------------- inlining ----------------------------------

function sroaParamFieldMaps(
  callee: FnT,
  args: number[],
  sroad: Map<number, Map<number, number>>,
  alias: Map<number, number>
): Map<number, Map<number, number>> {
  const maps = new Map<number, Map<number, number>>();
  callee.params.forEach((p, i) => {
    if (i < args.length) {
      const root = resolveAliasRoot(args[i], alias);
      const fmap = sroad.get(root);
      if (fmap !== undefined) maps.set(p, fmap);
    }
  });
  return maps;
}

/** Inline a small straight-line free function (params -> args, locals fresh,
 *  tail Return -> Copy into dst). */
function inlineFreeFn(
  callee: FnT,
  args: number[],
  dst: number | undefined,
  st: { next: number; newLocals: any[] },
  out: Inst[],
  scalarParamFields: Map<number, Map<number, number>> | undefined
): void {
  const subst = new Map<number, number>();
  callee.params.forEach((p, i) => {
    if (i < args.length) subst.set(p, args[i]);
  });
  for (const l of callee.locals) {
    if (!callee.params.some((p) => p === l.id)) {
      const nl = freshLocal(st, l.refKind !== "primitive");
      subst.set(l.id, nl);
    }
  }
  const m = (id: number) => subst.get(id) ?? id;
  for (const inst of callee.body) {
    switch (inst.kind) {
      case "Const":
        out.push({ ...inst, dst: m(inst.dst) });
        break;
      case "BinOp":
        out.push({ ...inst, dst: m(inst.dst), lhs: m(inst.lhs), rhs: m(inst.rhs) });
        break;
      case "UnOp":
        out.push({ ...inst, dst: m(inst.dst), operand: m(inst.operand) });
        break;
      case "Copy":
        out.push({ ...inst, dst: m(inst.dst), src: m(inst.src) });
        break;
      case "LoadField": {
        const fmap = scalarParamFields?.get(inst.obj);
        const fs = fmap?.get(inst.field);
        if (fs !== undefined) {
          out.push({ kind: "Copy", dst: m(inst.dst), src: fs });
        } else {
          out.push({ ...inst, dst: m(inst.dst), obj: m(inst.obj) });
        }
        break;
      }
      case "StoreField": {
        const fmap = scalarParamFields?.get(inst.obj);
        const fs = fmap?.get(inst.field);
        if (fs !== undefined) {
          out.push({ kind: "Copy", dst: fs, src: m(inst.src) });
        } else {
          out.push({ ...inst, obj: m(inst.obj), src: m(inst.src) });
        }
        break;
      }
      case "Return":
        if (dst !== undefined && inst.src !== undefined && inst.src !== null) {
          out.push({ kind: "Copy", dst, src: m(inst.src) });
        }
        break;
      default:
        break; // unreachable: isInlinableFreeFn rejects other kinds
    }
  }
}

/** Inline a method/ctor body onto a scalar-replaced receiver: `this.fK` ->
 *  field scalar, params -> args, tail Return -> Copy into dst, recursive
 *  inlining of Direct `this` calls (super()/this.m()), everything else
 *  exhaustively remapped. */
function inlineCallee(
  callee: FnT,
  fmap: Map<number, number>,
  args: number[],
  dst: number | undefined,
  st: { next: number; newLocals: any[] },
  out: Inst[],
  bodies: Map<number, FnT>,
  depth: number
): void {
  const subst = new Map<number, number>();
  callee.params.forEach((p, i) => {
    if (i === 0) return; // this
    if (i - 1 < args.length) subst.set(p, args[i - 1]);
  });
  for (const l of callee.locals) {
    if (!callee.params.some((p) => p === l.id)) {
      const nl = freshLocal(st, l.refKind !== "primitive");
      subst.set(l.id, nl);
    }
  }
  const thisLocal = callee.params.length > 0 ? callee.params[0] : undefined;
  const m = (id: number) => subst.get(id) ?? id;

  for (const inst of callee.body) {
    if (inst.kind === "LoadField" && inst.obj === thisLocal) {
      const fs = fmap.get(inst.field);
      if (fs !== undefined) out.push({ kind: "Copy", dst: m(inst.dst), src: fs });
      else out.push({ ...inst, dst: m(inst.dst), obj: m(inst.obj) });
    } else if (inst.kind === "StoreField" && inst.obj === thisLocal) {
      const fs = fmap.get(inst.field);
      if (fs !== undefined) out.push({ kind: "Copy", dst: fs, src: m(inst.src) });
      else out.push({ ...inst, obj: m(inst.obj), src: m(inst.src) });
    } else if (
      inst.kind === "Call" &&
      inst.callee?.kind === "Direct" &&
      inst.recv !== undefined && inst.recv !== null && inst.recv === thisLocal &&
      depth < 16
    ) {
      const inner = bodies.get(inst.callee.func);
      if (inner !== undefined && !inner.isGenerator && !inner.isAsync) {
        const mappedArgs: number[] = (inst.args ?? []).map(m);
        const cd = inst.dst === undefined || inst.dst === null ? undefined : m(inst.dst);
        inlineCallee(inner, fmap, mappedArgs, cd, st, out, bodies, depth + 1);
      } else {
        out.push({
          kind: "Call",
          dst: inst.dst === undefined || inst.dst === null ? null : m(inst.dst),
          callee: { kind: "Direct", func: inst.callee.func },
          recv: m(inst.recv),
          args: (inst.args ?? []).map(m),
          resolvedSig: null,
        });
      }
    } else if (inst.kind === "Return") {
      if (dst !== undefined && inst.src !== undefined && inst.src !== null) {
        out.push({ kind: "Copy", dst, src: m(inst.src) });
      }
    } else if (inst.kind === "Const") {
      out.push({ ...inst, dst: m(inst.dst) });
    } else if (inst.kind === "BinOp") {
      out.push({ ...inst, dst: m(inst.dst), lhs: m(inst.lhs), rhs: m(inst.rhs) });
    } else if (inst.kind === "UnOp") {
      out.push({ ...inst, dst: m(inst.dst), operand: m(inst.operand) });
    } else if (inst.kind === "Copy") {
      out.push({ ...inst, dst: m(inst.dst), src: m(inst.src) });
    } else if (inst.kind === "LoadField") {
      out.push({ ...inst, dst: m(inst.dst), obj: m(inst.obj) });
    } else if (inst.kind === "StoreField") {
      out.push({ ...inst, obj: m(inst.obj), src: m(inst.src) });
    } else {
      out.push(remapInstOperands(inst, m));
    }
  }
}

function trimTrailingAllocProtoLoad(out: Inst[], protoLocal: number): void {
  const last = out.length > 0 ? out[out.length - 1] : undefined;
  if (!(last && last.kind === "LoadField" && last.dst === protoLocal)) return;
  const classValueLocal = last.obj;
  out.pop();
  const prev = out.length > 0 ? out[out.length - 1] : undefined;
  if (
    prev &&
    (prev.kind === "LoadField" || prev.kind === "LoadGlobal" || prev.kind === "Copy") &&
    prev.dst === classValueLocal
  ) {
    out.pop();
  }
}

// ------------------------------- rewrite body -------------------------------

interface RewriteCtx {
  numberLocs: Set<number>;
  noescape: Set<number>;
  classFields: Map<number, number[]>;
  bodies: Map<number, FnT>;
  st: { next: number; newLocals: any[] };
  sroad: Map<number, Map<number, number>>;
  numericFields: Set<string>; // `${cls},${fid}`
  numericScalars: Set<number>;
  curFn: number;
}

function rewriteBody(body: Inst[], cx: RewriteCtx, outside: Set<number>): Inst[] {
  const targets = findSroaTargets(body, cx.noescape, cx.classFields, cx.bodies);
  // BTreeMap order (ascending recv id): fresh-scalar ids must match Rust's.
  for (const [recv, cls] of [...targets].sort((a, b) => a[0] - b[0])) {
    const fmap = new Map<number, number>();
    const fields = cx.classFields.get(cls);
    if (fields !== undefined) {
      for (const f of fields) {
        const isNumeric = cx.numericFields.has(`${cls},${f}`);
        const sc = freshLocal(cx.st, !isNumeric);
        if (isNumeric) cx.numericScalars.add(sc);
        fmap.set(f, sc);
      }
    }
    cx.sroad.set(recv, fmap);
  }

  const arrayTargets = findArraySroaTargets(body, cx.numberLocs, outside);
  const arrayScalars = new Map<number, Map<number, number>>();
  const arrayLengths = new Map<number, number>();
  for (const [arr, target] of [...arrayTargets].sort((a, b) => a[0] - b[0])) {
    const imap = new Map<number, number>();
    for (const idx of [...target.indices].sort((a, b) => a - b)) {
      const isNumeric = target.numericIndices.has(idx);
      const sc = freshLocal(cx.st, !isNumeric);
      if (isNumeric) cx.numericScalars.add(sc);
      imap.set(idx, sc);
    }
    arrayScalars.set(arr, imap);
    arrayLengths.set(arr, 0);
  }

  const out: Inst[] = [];
  const alias = new Map<number, number>();
  const arrayAlias = new Map<number, number>();
  const constIndices = new Map<number, number>();
  const allocClass = new Map<number, number>();

  for (let instIdx = 0; instIdx < body.length; instIdx++) {
    const inst = body[instIdx];
    if (inst.kind === "AllocObject" && inst.classId !== undefined && inst.classId !== null) {
      allocClass.set(inst.dst, inst.classId);
    }
    if (inst.kind === "AllocArray" && arrayScalars.has(inst.dst)) {
      invalidateArrayTrackingDef(inst.dst, arrayAlias, constIndices);
      arrayLengths.set(inst.dst, 0);
      continue;
    }
    if (inst.kind === "AllocObject" && cx.sroad.has(inst.dst)) {
      if (inst.proto !== undefined && inst.proto !== null) trimTrailingAllocProtoLoad(out, inst.proto);
      continue;
    }
    if (inst.kind === "Const") {
      invalidateArrayTrackingDef(inst.dst, arrayAlias, constIndices);
      const idx = constArrayIndexValue(inst.value);
      if (idx !== undefined) constIndices.set(inst.dst, idx);
      out.push(inst);
      continue;
    }
    if (inst.kind === "Copy") {
      const copiedConst = constIndices.get(inst.src);
      invalidateArrayTrackingDef(inst.dst, arrayAlias, constIndices);
      if (copiedConst !== undefined) constIndices.set(inst.dst, copiedConst);
      const rsrc = resolveAliasRoot(inst.src, alias);
      if (cx.sroad.has(rsrc)) {
        alias.set(inst.dst, rsrc); // alias, no emit
      } else {
        const aroot = arrayRootForScalars(inst.src, arrayScalars, arrayAlias);
        if (aroot !== undefined) arrayAlias.set(inst.dst, aroot);
        else out.push(inst);
      }
      continue;
    }
    if (inst.kind === "StoreIndex") {
      const root = arrayRootForScalars(inst.arr, arrayScalars, arrayAlias);
      if (root !== undefined) {
        const idx = constIndices.get(inst.index);
        if (idx !== undefined) {
          const sc = arrayScalars.get(root)?.get(idx);
          if (sc !== undefined) out.push({ kind: "Copy", dst: sc, src: inst.src });
          const len = arrayLengths.get(root) ?? 0;
          arrayLengths.set(root, Math.max(len, idx + 1));
          continue;
        }
      }
      out.push(inst);
      continue;
    }
    if (inst.kind === "LoadIndex") {
      invalidateArrayTrackingDef(inst.dst, arrayAlias, constIndices);
      const root = arrayRootForScalars(inst.arr, arrayScalars, arrayAlias);
      if (root !== undefined) {
        const idx = constIndices.get(inst.index);
        if (idx !== undefined) {
          const sc = arrayScalars.get(root)?.get(idx);
          if (sc === undefined) throw new Error("array sroa scalar for LoadIndex");
          out.push({ kind: "Copy", dst: inst.dst, src: sc });
          continue;
        }
      }
      out.push(inst);
      continue;
    }
    if (inst.kind === "StoreFieldDynamic") {
      const root = arrayRootForScalars(inst.obj, arrayScalars, arrayAlias);
      if (root !== undefined) {
        const idx = constIndices.get(inst.key);
        if (idx !== undefined) {
          const sc = arrayScalars.get(root)?.get(idx);
          if (sc !== undefined) out.push({ kind: "Copy", dst: sc, src: inst.src });
          const len = arrayLengths.get(root) ?? 0;
          arrayLengths.set(root, Math.max(len, idx + 1));
          continue;
        }
      }
      out.push(inst);
      continue;
    }
    if (inst.kind === "LoadFieldDynamic") {
      invalidateArrayTrackingDef(inst.dst, arrayAlias, constIndices);
      const root = arrayRootForScalars(inst.obj, arrayScalars, arrayAlias);
      if (root !== undefined) {
        const idx = constIndices.get(inst.key);
        if (idx !== undefined) {
          const sc = arrayScalars.get(root)?.get(idx);
          if (sc === undefined) throw new Error("array sroa scalar for LoadFieldDynamic");
          out.push({ kind: "Copy", dst: inst.dst, src: sc });
          continue;
        }
      }
      out.push(inst);
      continue;
    }
    if (inst.kind === "ArrayLen") {
      invalidateArrayTrackingDef(inst.dst, arrayAlias, constIndices);
      const root = arrayRootForScalars(inst.arr, arrayScalars, arrayAlias);
      if (root !== undefined) {
        const len = arrayLengths.get(root) ?? 0;
        constIndices.set(inst.dst, len);
        out.push({ kind: "Const", dst: inst.dst, value: { kind: "Num", value: len } });
        continue;
      }
      out.push(inst);
      continue;
    }
    if (inst.kind === "Call" && inst.callee?.kind === "Direct" && inst.recv !== undefined && inst.recv !== null) {
      const rr = resolveAliasRoot(inst.recv, alias);
      const fmap = cx.sroad.get(rr);
      if (fmap !== undefined) {
        const callee = cx.bodies.get(inst.callee.func);
        if (
          callee !== undefined &&
          returnsOnlyInTailPosition(callee) &&
          !capturesThis(callee) &&
          !callee.isGenerator &&
          !callee.isAsync
        ) {
          const d = inst.dst === undefined || inst.dst === null ? undefined : inst.dst;
          if (d !== undefined) invalidateArrayTrackingDef(d, arrayAlias, constIndices);
          inlineCallee(callee, fmap, inst.args ?? [], d, cx.st, out, cx.bodies, 0);
          continue;
        }
      }
      const callee = cx.bodies.get(inst.callee.func);
      if (callee !== undefined && callee.id !== cx.curFn && isInlinableFreeFn(callee)) {
        const recvFresh = allocClass.has(resolveAliasRoot(inst.recv, alias));
        const touchesThis = calleeTouchesParam0Fields(callee);
        if (recvFresh || !touchesThis) {
          const eff: number[] = [inst.recv, ...(inst.args ?? [])];
          if (eff.length === callee.params.length) {
            const d = inst.dst === undefined || inst.dst === null ? undefined : inst.dst;
            if (d !== undefined) invalidateArrayTrackingDef(d, arrayAlias, constIndices);
            inlineFreeFn(callee, eff, d, cx.st, out, undefined);
            continue;
          }
        }
      }
      invalidateArrayTrackingDefs(inst, arrayAlias, constIndices);
      out.push(inst);
      continue;
    }
    if (inst.kind === "Call" && inst.callee?.kind === "Direct" && (inst.recv === undefined || inst.recv === null)) {
      const callee = cx.bodies.get(inst.callee.func);
      const args: number[] = inst.args ?? [];
      if (callee !== undefined && callee.id !== cx.curFn && isInlinableFreeFn(callee) && args.length === callee.params.length) {
        const scalarParamFields = sroaParamFieldMaps(callee, args, cx.sroad, alias);
        const d = inst.dst === undefined || inst.dst === null ? undefined : inst.dst;
        if (d !== undefined) invalidateArrayTrackingDef(d, arrayAlias, constIndices);
        inlineFreeFn(callee, args, d, cx.st, out, scalarParamFields.size === 0 ? undefined : scalarParamFields);
        continue;
      }
      invalidateArrayTrackingDefs(inst, arrayAlias, constIndices);
      out.push(inst);
      continue;
    }
    if (inst.kind === "LoadField") {
      const robj = resolveAliasRoot(inst.obj, alias);
      const fmap = cx.sroad.get(robj);
      const sc = fmap?.get(inst.field);
      if (sc !== undefined) {
        invalidateArrayTrackingDef(inst.dst, arrayAlias, constIndices);
        out.push({ kind: "Copy", dst: inst.dst, src: sc });
        continue;
      }
      invalidateArrayTrackingDefs(inst, arrayAlias, constIndices);
      out.push(inst);
      continue;
    }
    if (inst.kind === "StoreField") {
      const robj = resolveAliasRoot(inst.obj, alias);
      const fmap = cx.sroad.get(robj);
      const sc = fmap?.get(inst.field);
      if (sc !== undefined) {
        out.push({ kind: "Copy", dst: sc, src: inst.src });
        continue;
      }
      invalidateArrayTrackingDefs(inst, arrayAlias, constIndices);
      out.push(inst);
      continue;
    }
    if (inst.kind === "Loop") {
      const surround = new Set(outside);
      collectLocalRefs(body.slice(0, instIdx), surround);
      collectLocalRefs(body.slice(instIdx + 1), surround);
      surround.add(inst.cond);
      const condOutside = new Set(surround);
      collectLocalRefs(inst.body ?? [], condOutside);
      const bodyOutside = surround;
      collectLocalRefs(inst.condBody ?? [], bodyOutside);
      const cb = rewriteBody(inst.condBody ?? [], cx, condOutside);
      const bb = rewriteBody(inst.body ?? [], cx, bodyOutside);
      arrayAlias.clear();
      constIndices.clear();
      out.push({ kind: "Loop", cond: inst.cond, condBody: cb, body: bb });
      continue;
    }
    if (inst.kind === "If") {
      const surround = new Set(outside);
      collectLocalRefs(body.slice(0, instIdx), surround);
      collectLocalRefs(body.slice(instIdx + 1), surround);
      surround.add(inst.cond);
      const thenOutside = new Set(surround);
      collectLocalRefs(inst.elseBody ?? [], thenOutside);
      const elseOutside = surround;
      collectLocalRefs(inst.thenBody ?? [], elseOutside);
      const tb = rewriteBody(inst.thenBody ?? [], cx, thenOutside);
      const eb = rewriteBody(inst.elseBody ?? [], cx, elseOutside);
      arrayAlias.clear();
      constIndices.clear();
      out.push({ kind: "If", cond: inst.cond, thenBody: tb, elseBody: eb });
      continue;
    }
    invalidateArrayTrackingDefs(inst, arrayAlias, constIndices);
    out.push(inst);
  }
  return out;
}

// --------------------------- numeric propagation ----------------------------

function propagateNumeric(body: Inst[], primitiveLocs: Set<number>, numeric: Set<number>, st: { changed: boolean }): void {
  const isNum = (id: number) => numeric.has(id) || primitiveLocs.has(id);
  for (const inst of body) {
    switch (inst.kind) {
      case "Const":
        if (constIsNumberValue(inst.value) && !numeric.has(inst.dst)) {
          numeric.add(inst.dst);
          st.changed = true;
        }
        break;
      case "Copy":
        if (numeric.has(inst.src) && !numeric.has(inst.dst)) {
          numeric.add(inst.dst);
          st.changed = true;
        }
        break;
      case "UnOp":
        if (NUM_UNOPS.has(inst.op) && isNum(inst.operand) && !numeric.has(inst.dst)) {
          numeric.add(inst.dst);
          st.changed = true;
        }
        break;
      case "BinOp":
        if (NUM_BINOPS.has(inst.op) && isNum(inst.lhs) && isNum(inst.rhs) && !numeric.has(inst.dst)) {
          numeric.add(inst.dst);
          st.changed = true;
        }
        break;
      case "Loop":
        propagateNumeric(inst.condBody ?? [], primitiveLocs, numeric, st);
        propagateNumeric(inst.body ?? [], primitiveLocs, numeric, st);
        break;
      case "If":
        propagateNumeric(inst.thenBody ?? [], primitiveLocs, numeric, st);
        propagateNumeric(inst.elseBody ?? [], primitiveLocs, numeric, st);
        break;
      case "TryCatch":
        propagateNumeric(inst.tryBody ?? [], primitiveLocs, numeric, st);
        propagateNumeric(inst.catchBody ?? [], primitiveLocs, numeric, st);
        propagateNumeric(inst.finallyBody ?? [], primitiveLocs, numeric, st);
        break;
      default:
        break;
    }
  }
}

// ---------------------------------- driver ----------------------------------

export function runSroa(prog: Program, result: EscapeResult): void {
  const classes: any[] = (prog as any).classes ?? [];

  // (class, field) pairs monomorphized to "number", extended with inheritance.
  const numericFields = new Set<string>();
  for (const c of classes) {
    const ft = c.fieldTypes ?? {};
    for (const k of Object.keys(ft)) {
      if (ft[k] === "number") {
        const fid = parseInt(k, 10);
        if (!Number.isNaN(fid)) numericFields.add(`${c.id},${fid}`);
      }
    }
  }
  const noescape = new Set<number>();
  for (const s of result.sites) if (s.state === "noEscape") noescape.add(s.site);

  const parentOf = new Map<number, number | null>();
  for (const c of classes) parentOf.set(c.id, c.parent ?? null);
  const ownFields = new Map<number, number[]>();
  for (const c of classes) ownFields.set(c.id, [...(c.ownFields ?? [])]);
  const allFields = (c: number): number[] => {
    const v: number[] = [];
    const p = parentOf.get(c);
    if (p !== null && p !== undefined) {
      const pf = allFields(p);
      for (const f of pf) v.push(f);
    }
    const own = ownFields.get(c);
    if (own !== undefined) {
      for (const f of own) v.push(f);
    }
    return v;
  };
  const classFields = new Map<number, number[]>();
  for (const c of classes) classFields.set(c.id, allFields(c.id));

  // inherited numeric fields (prefix layout: same field id at same offset)
  {
    const snapshot = [...numericFields];
    for (const e of snapshot) {
      const comma = e.indexOf(",");
      const cls = parseInt(e.slice(0, comma), 10);
      const fid = e.slice(comma + 1);
      for (const desc of classes) {
        let p = parentOf.get(desc.id) ?? null;
        while (p !== null && p !== undefined) {
          if (p === cls) {
            numericFields.add(`${desc.id},${fid}`);
            break;
          }
          p = parentOf.get(p) ?? null;
        }
      }
    }
  }

  // snapshot callee bodies (immutable, DEEP — Rust clones) before mutating
  // functions: later functions' inlining must see the PRE-SROA callee bodies.
  // Structural clone (not JSON round-trip): the self-hosted analyzer's own IR
  // nests deeper than the runtime's JSON.stringify cycle guard allows.
  const bodies = new Map<number, FnT>();
  for (const f of prog.functions) bodies.set(f.id, deepCloneJson(f) as FnT);

  for (const fn of prog.functions as unknown as FnT[]) {
    let maxLocal = 0;
    for (const l of fn.locals) if (l.id > maxLocal) maxLocal = l.id;
    const st = { next: maxLocal + 1, newLocals: [] as any[] };
    const numberLocs = collectNumberLocs(fn.body);
    const sroad = new Map<number, Map<number, number>>();
    const numericScalars = new Set<number>();
    const cx: RewriteCtx = {
      numberLocs,
      noescape,
      classFields,
      bodies,
      st,
      sroad,
      numericFields,
      numericScalars,
      curFn: fn.id,
    };
    const rewritten = rewriteBody(fn.body, cx, new Set());
    for (const nl of st.newLocals) fn.locals.push(nl);
    fn.body = rewritten;
    {
      const numeric = new Set(numericScalars);
      const primitiveLocs = new Set<number>();
      for (const l of fn.locals) if (l.refKind === "primitive") primitiveLocs.add(l.id);
      const pst = { changed: true };
      while (pst.changed) {
        pst.changed = false;
        propagateNumeric(rewritten, primitiveLocs, numeric, pst);
      }
      for (const l of fn.locals) {
        if (numeric.has(l.id)) l.refKind = "primitive";
      }
    }
  }
}
