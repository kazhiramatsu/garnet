/**
 * P2 (call graph + SCC) and P3 (interprocedural, summary-based escape analysis)
 * — the TypeScript port of analyzer/src/call_graph.rs + interproc.rs.
 *
 * Connection-graph summaries (Choi-style), callee internals collapsed to one
 * `Internal` node; phantom param-field nodes capture "callee leaks a field of
 * a parameter" effects; closures apply the lifted body's summary to the
 * captured cells at creation. Summaries are built bottom-up over the SCC
 * condensation; recursion nests iterate from the empty summary to a least
 * fixpoint. The output is `{version, sites:[{site, state}]}` — byte-comparable
 * to the Rust `tsaot <ir> escape` dump.
 *
 * Encodings (Rust enums -> string keys, so JS Map/Set can hold them):
 *   FieldKey: `N<fieldId>` | `E` (elem) | `C<binding>` (capture)
 *   Obj:      `S<site>` | `P<local>` | `F<local>|<fieldKey>` (ParamField)
 *             | `X` (external) | `O<n>` (opaque)
 *   Ref:      `L<local>` | `R` (ret) | `G` (global) | `T<n>` (temp)
 *   SObj:     `p<i>` (param) | `I` (internal) | `X` (external) | `G` (global)
 */
import { Program } from "./ir";

// ------------------------------- call graph ---------------------------------

export interface CallGraph {
  callees: number[][];
  hasUnknown: boolean[];
  selfRecursive: boolean[];
  order: number[][]; // SCCs, bottom-up (callees-first)
}

export function isCyclic(cg: CallGraph, scc: number[]): boolean {
  return scc.length > 1 || (scc.length === 1 && cg.selfRecursive[scc[0]]);
}

export function buildCallGraph(prog: Program): CallGraph {
  let n = prog.functions.length;
  for (const f of prog.functions) if (f.id + 1 > n) n = f.id + 1;
  const callees: number[][] = [];
  const hasUnknown: boolean[] = [];
  const selfRecursive: boolean[] = [];
  for (let i = 0; i < n; i++) {
    callees.push([]);
    hasUnknown.push(false);
    selfRecursive.push(false);
  }

  for (const f of prog.functions) {
    const i = f.id;
    const set = new Set<number>();
    const stack: any[] = [...(f.body as any[])];
    while (stack.length > 0) {
      const inst = stack.pop();
      if (inst.kind === "Call") {
        const c = inst.callee;
        if (c.kind === "Direct") set.add(c.func);
        else if (c.kind === "Set") for (const g of c.funcs ?? []) set.add(g);
        else hasUnknown[i] = true; // Method / Value / Unknown
      } else if (inst.kind === "CallSpread") {
        const c = inst.callee;
        if (c.kind === "Direct") set.add(c.func);
        else if (c.kind === "Set") for (const g of c.funcs ?? []) set.add(g);
        else hasUnknown[i] = true;
      } else if (inst.kind === "AllocClosure") {
        set.add(inst.func);
      } else if (inst.kind === "Loop") {
        for (const x of inst.condBody ?? []) stack.push(x);
        for (const x of inst.body ?? []) stack.push(x);
      } else if (inst.kind === "If") {
        for (const x of inst.thenBody ?? []) stack.push(x);
        for (const x of inst.elseBody ?? []) stack.push(x);
      } else if (inst.kind === "TryCatch") {
        for (const x of inst.tryBody ?? []) stack.push(x);
        for (const x of inst.catchBody ?? []) stack.push(x);
        for (const x of inst.finallyBody ?? []) stack.push(x);
      }
    }
    if (set.has(i)) selfRecursive[i] = true;
    callees[i] = [...set].sort((a, b) => a - b).filter((g) => g < n);
  }

  return { callees, hasUnknown, selfRecursive, order: tarjanScc(callees) };
}

/** Iterative Tarjan; SCCs in reverse-topological (bottom-up) order. */
function tarjanScc(adj: number[][]): number[][] {
  const n = adj.length;
  const index: (number | undefined)[] = new Array(n).fill(undefined);
  const lowlink: number[] = new Array(n).fill(0);
  const onStack: boolean[] = new Array(n).fill(false);
  const nextChild: number[] = new Array(n).fill(0);
  const tstack: number[] = [];
  const sccs: number[][] = [];
  let counter = 0;

  for (let s = 0; s < n; s++) {
    if (index[s] !== undefined) continue;
    const dfs: number[] = [s];
    while (dfs.length > 0) {
      const v = dfs[dfs.length - 1];
      if (index[v] === undefined) {
        index[v] = counter;
        lowlink[v] = counter;
        counter++;
        tstack.push(v);
        onStack[v] = true;
      }
      let recursed = false;
      while (nextChild[v] < adj[v].length) {
        const w = adj[v][nextChild[v]];
        nextChild[v]++;
        if (index[w] === undefined) {
          dfs.push(w);
          recursed = true;
          break;
        } else if (onStack[w]) {
          if ((index[w] as number) < lowlink[v]) lowlink[v] = index[w] as number;
        }
      }
      if (recursed) continue;
      if (lowlink[v] === index[v]) {
        const comp: number[] = [];
        for (;;) {
          const x = tstack.pop() as number;
          onStack[x] = false;
          comp.push(x);
          if (x === v) break;
        }
        sccs.push(comp);
      }
      dfs.pop();
      if (dfs.length > 0) {
        const p = dfs[dfs.length - 1];
        if (lowlink[v] < lowlink[p]) lowlink[p] = lowlink[v];
      }
    }
  }
  return sccs;
}

// ------------------------------- constraints --------------------------------

type C =
  | { t: "Addr"; r: string; o: string }
  | { t: "Copy"; d: string; s: string }
  | { t: "Load"; d: string; b: string; f: string }
  | { t: "Store"; b: string; f: string; s: string }
  | { t: "StoreObj"; o: string; f: string; s: string }
  | { t: "StoreLit"; b: string; f: string; v: string }
  | { t: "AddrField"; b: string; f: string; v: string };

const REF_RET = "R";
const REF_GLOBAL = "G";
const OBJ_EXTERNAL = "X";
const refLocal = (l: number) => `L${l}`;
const objSite = (s: number) => `S${s}`;
const objParam = (p: number) => `P${p}`;
const objParamField = (p: number, fk: string) => `F${p}|${fk}`;
const fkNamed = (f: number) => `N${f}`;
const FK_ELEM = "E";
const fkCapture = (b: number) => `C${b}`;

class Solver {
  pt = new Map<string, Set<string>>();
  /** field map: `${obj}#${fieldKey}` -> targets; obj/fieldKey recoverable by split('#'). */
  field = new Map<string, Set<string>>();

  ptOf(r: string): Set<string> {
    let s = this.pt.get(r);
    if (s === undefined) {
      s = new Set();
      this.pt.set(r, s);
    }
    return s;
  }
  ptClone(r: string): string[] {
    const s = this.pt.get(r);
    return s === undefined ? [] : [...s];
  }
  fieldOf(o: string, f: string): Set<string> {
    const k = `${o}#${f}`;
    let s = this.field.get(k);
    if (s === undefined) {
      s = new Set();
      this.field.set(k, s);
    }
    return s;
  }

  solve(cs: C[]): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of cs) {
        if (c.t === "Addr") {
          const s = this.ptOf(c.r);
          if (!s.has(c.o)) {
            s.add(c.o);
            changed = true;
          }
        } else if (c.t === "Copy") {
          const src = this.ptClone(c.s);
          const d = this.ptOf(c.d);
          for (const o of src) {
            if (!d.has(o)) {
              d.add(o);
              changed = true;
            }
          }
        } else if (c.t === "Load") {
          const bases = this.ptClone(c.b);
          const acc: string[] = [];
          for (const o of bases) {
            // Phantom param-field: loading a field of a parameter object
            // yields its caller-provided contents node.
            if (o.charCodeAt(0) === 80 /* 'P' */) {
              acc.push(objParamField(parseInt(o.slice(1), 10), c.f));
            }
            const fs = this.field.get(`${o}#${c.f}`);
            if (fs !== undefined) for (const t of fs) acc.push(t);
          }
          const d = this.ptOf(c.d);
          for (const o of acc) {
            if (!d.has(o)) {
              d.add(o);
              changed = true;
            }
          }
        } else if (c.t === "Store") {
          const bases = this.ptClone(c.b);
          const src = this.ptClone(c.s);
          for (const o of bases) {
            const fs = this.fieldOf(o, c.f);
            for (const v of src) {
              if (!fs.has(v)) {
                fs.add(v);
                changed = true;
              }
            }
          }
        } else if (c.t === "StoreObj") {
          const src = this.ptClone(c.s);
          const fs = this.fieldOf(c.o, c.f);
          for (const v of src) {
            if (!fs.has(v)) {
              fs.add(v);
              changed = true;
            }
          }
        } else if (c.t === "StoreLit") {
          const bases = this.ptClone(c.b);
          for (const o of bases) {
            const fs = this.fieldOf(o, c.f);
            if (!fs.has(c.v)) {
              fs.add(c.v);
              changed = true;
            }
          }
        } else {
          // AddrField
          const fs = this.fieldOf(c.b, c.f);
          if (!fs.has(c.v)) {
            fs.add(c.v);
            changed = true;
          }
        }
      }
    }
  }

  /** Transitive closure of `seed` over field edges (contents reachable from). */
  fieldClosure(seed: Set<string>): Set<string> {
    const set = new Set(seed);
    const work = [...set];
    while (work.length > 0) {
      const o = work.pop() as string;
      const prefix = `${o}#`;
      for (const [k, tgts] of this.field) {
        if (k.startsWith(prefix)) {
          for (const t of tgts) {
            if (!set.has(t)) {
              set.add(t);
              work.push(t);
            }
          }
        }
      }
    }
    return set;
  }

  globalSet(): Set<string> {
    const seed = new Set(this.ptClone(REF_GLOBAL));
    seed.add(OBJ_EXTERNAL);
    return this.fieldClosure(seed);
  }
}

// -------------------------------- summaries ---------------------------------

/** SObj encoding: `p<i>` | `I` | `X` | `G`. */
interface Summary {
  nparams: number;
  paramGlobal: boolean[];
  fields: Set<string>; // `${sobj},${fieldKey},${sobj}`
  ret: Set<string>; // SObj
  fieldGlobal: Set<string>; // `${i},${fieldKey}`
  fieldRet: Set<string>; // `${i},${fieldKey}`
}

function emptySummary(nparams: number): Summary {
  const paramGlobal: boolean[] = [];
  for (let i = 0; i < nparams; i++) paramGlobal.push(false);
  return { nparams, paramGlobal, fields: new Set(), ret: new Set(), fieldGlobal: new Set(), fieldRet: new Set() };
}

/** Canonical serialization for the SCC fixpoint's equality check. */
function summaryKey(s: Summary): string {
  return (
    s.nparams +
    ";" +
    s.paramGlobal.map((b) => (b ? "1" : "0")).join("") +
    ";" +
    [...s.fields].sort().join("/") +
    ";" +
    [...s.ret].sort().join("/") +
    ";" +
    [...s.fieldGlobal].sort().join("/") +
    ";" +
    [...s.fieldRet].sort().join("/")
  );
}

// --------------------------- constraint building ----------------------------

interface FnLite {
  id: number;
  params: number[];
  locals: { id: number; refKind?: string }[];
  body: any[];
  isExported?: boolean;
  isGenerator?: boolean;
  isAsync?: boolean;
}

function refMapOf(f: FnLite): Map<number, boolean> {
  const m = new Map<number, boolean>();
  for (const l of f.locals) m.set(l.id, l.refKind !== "primitive");
  return m;
}

/** Flatten Loop/If/TryCatch bodies (TryCatch nodes are kept so catchVar marks). */
function flattenBodies(body: any[], out: any[]): void {
  for (const inst of body) {
    if (inst.kind === "Loop") {
      flattenBodies(inst.condBody ?? [], out);
      flattenBodies(inst.body ?? [], out);
    } else if (inst.kind === "If") {
      flattenBodies(inst.thenBody ?? [], out);
      flattenBodies(inst.elseBody ?? [], out);
    } else if (inst.kind === "TryCatch") {
      flattenBodies(inst.tryBody ?? [], out);
      flattenBodies(inst.catchBody ?? [], out);
      flattenBodies(inst.finallyBody ?? [], out);
      out.push(inst);
    } else {
      out.push(inst);
    }
  }
}

/** Operand locals an instruction forces to MATERIALIZE (escape to the global
 *  sink) because the runtime reads the real heap object. Mirrors
 *  op_forces_materialization (single source of truth for SROA §3.4). */
function opForcesMaterialization(inst: any): number[] {
  switch (inst.kind) {
    case "Print": return [inst.src];
    case "BinOp": return inst.op === "+" ? [inst.lhs, inst.rhs] : [];
    case "HasField": return [inst.obj];
    case "HasFieldDynamic": return [inst.obj, inst.key];
    case "LoadFieldDynamic": return [inst.obj];
    case "StoreFieldDynamic": return [inst.obj, inst.key];
    case "ObjectCopyProps": return [inst.src];
    case "ConstructResult": return [inst.inst, inst.ret];
    case "StoreProtoMethod": return [inst.src];
    case "StoreMethod": return [inst.obj, inst.src];
    case "SetProto": return [inst.proto];
    case "Yield": return [inst.operand];
    case "Await": return [inst.operand];
    case "Throw": return [inst.src];
    case "StoreGlobal": return [inst.src];
    default: return [];
  }
}

function buildConstraints(f: FnLite, summaries: (Summary | undefined)[]): { cs: C[]; sites: number[] } {
  const refMap = refMapOf(f);
  const isRef = (id: number) => refMap.get(id) ?? true;

  const cs: C[] = [];
  const sites: number[] = [];
  const counters = { opaque: 0, temp: 0 };

  for (const p of f.params) {
    if (isRef(p)) cs.push({ t: "Addr", r: refLocal(p), o: objParam(p) });
  }

  const conservative = (actuals: number[], dst: number | undefined) => {
    for (const a of actuals) {
      if (isRef(a)) cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(a) });
    }
    if (dst !== undefined && isRef(dst)) cs.push({ t: "Addr", r: refLocal(dst), o: OBJ_EXTERNAL });
  };

  const flat: any[] = [];
  flattenBodies(f.body, flat);
  for (const inst of flat) {
    for (const m of opForcesMaterialization(inst)) {
      cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(m) });
    }
    switch (inst.kind) {
      case "AllocObject":
      case "AllocArray":
        cs.push({ t: "Addr", r: refLocal(inst.dst), o: objSite(inst.site) });
        sites.push(inst.site);
        break;
      case "AllocClosure": {
        cs.push({ t: "Addr", r: refLocal(inst.dst), o: objSite(inst.site) });
        sites.push(inst.site);
        const captures: { binding: number; cell: number }[] = inst.captures ?? [];
        for (const cap of captures) {
          cs.push({ t: "StoreObj", o: objSite(inst.site), f: fkCapture(cap.binding), s: refLocal(cap.cell) });
        }
        const sum = summaries[inst.func];
        if (sum !== undefined) {
          applySummary(sum, captures.map((c) => c.cell), undefined, isRef, cs, counters, true);
        }
        break;
      }
      case "Copy":
        cs.push({ t: "Copy", d: refLocal(inst.dst), s: refLocal(inst.src) });
        break;
      case "LoadField":
        cs.push({ t: "Load", d: refLocal(inst.dst), b: refLocal(inst.obj), f: fkNamed(inst.field) });
        break;
      case "StoreField":
        cs.push({ t: "Store", b: refLocal(inst.obj), f: fkNamed(inst.field), s: refLocal(inst.src) });
        break;
      case "LoadElem":
        cs.push({ t: "Load", d: refLocal(inst.dst), b: refLocal(inst.arr), f: FK_ELEM });
        break;
      case "StoreElem":
        cs.push({ t: "Store", b: refLocal(inst.arr), f: FK_ELEM, s: refLocal(inst.src) });
        break;
      case "LoadIndex":
        cs.push({ t: "Load", d: refLocal(inst.dst), b: refLocal(inst.arr), f: FK_ELEM });
        break;
      case "StoreIndex":
        cs.push({ t: "Store", b: refLocal(inst.arr), f: FK_ELEM, s: refLocal(inst.src) });
        break;
      case "ArrayPush":
      case "ArrayPushAll":
        cs.push({ t: "Store", b: refLocal(inst.arr), f: FK_ELEM, s: refLocal(inst.src) });
        break;
      case "HasField":
      case "HasFieldDynamic":
        break; // materialization via opForcesMaterialization
      case "LoadFieldDynamic":
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "StoreFieldDynamic":
        cs.push({ t: "Store", b: refLocal(inst.obj), f: FK_ELEM, s: refLocal(inst.src) });
        break;
      case "DeleteField":
        break;
      case "ArraySlice":
        cs.push({ t: "Copy", d: refLocal(inst.dst), s: refLocal(inst.arr) });
        break;
      case "ObjectRest":
        cs.push({ t: "Copy", d: refLocal(inst.dst), s: refLocal(inst.src) });
        break;
      case "ObjectCopyProps":
        break;
      case "ConstructResult":
        cs.push({ t: "Copy", d: refLocal(inst.dst), s: refLocal(inst.inst) });
        break;
      case "ArrayLen":
      case "StringLen":
      case "Break":
      case "Continue":
        break;
      case "LoadClassProto":
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "StoreProtoMethod":
        break;
      case "StoreMethod":
        cs.push({ t: "Store", b: refLocal(inst.obj), f: FK_ELEM, s: refLocal(inst.src) });
        break;
      case "GetProto":
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "NewMap":
      case "NewSet":
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "CallBuiltin": {
        cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(inst.recv) });
        for (const a of inst.args ?? []) cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(a) });
        if (inst.dst !== undefined && isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      }
      case "CallBuiltinStatic": {
        for (const a of inst.args ?? []) cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(a) });
        if (inst.dst !== undefined && isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      }
      case "SetProto":
        break;
      case "Call": {
        const actuals: number[] = [];
        if (inst.recv !== undefined) actuals.push(inst.recv);
        for (const a of inst.args ?? []) actuals.push(a);
        const c = inst.callee;
        let callees: number[];
        if (c.kind === "Direct") callees = [c.func];
        else if (c.kind === "Set") callees = [...(c.funcs ?? [])];
        else {
          conservative(actuals, inst.dst);
          break;
        }
        for (const g of callees) {
          const sum = summaries[g];
          if (sum !== undefined) applySummary(sum, actuals, inst.dst, isRef, cs, counters, false);
          else conservative(actuals, inst.dst);
        }
        break;
      }
      case "CallSpread": {
        const actuals: number[] = [];
        if (inst.recv !== undefined) actuals.push(inst.recv);
        for (const spec of inst.argSpecs ?? []) actuals.push(spec.local);
        conservative(actuals, inst.dst);
        break;
      }
      case "Return":
        if (inst.src !== undefined) cs.push({ t: "Copy", d: REF_RET, s: refLocal(inst.src) });
        break;
      case "GenericLen":
        break;
      case "Yield":
      case "Await":
        if (inst.dst !== undefined && isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "Throw":
        break;
      case "TryCatch": {
        const cv = inst.catchVar;
        if (cv !== undefined && cv !== null && isRef(cv)) cs.push({ t: "Addr", r: refLocal(cv), o: OBJ_EXTERNAL });
        break;
      }
      case "StoreGlobal":
        break;
      case "LoadGlobal":
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "LoadMethodValue":
        cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(inst.recv) });
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "LoadBuiltinFn":
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        break;
      case "AllocClassValue": {
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        for (const cap of inst.captures ?? []) cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(cap.cell) });
        break;
      }
      case "NewDynamic": {
        if (isRef(inst.dst)) cs.push({ t: "Addr", r: refLocal(inst.dst), o: OBJ_EXTERNAL });
        cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(inst.callee) });
        for (const a of inst.args ?? []) cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(a) });
        break;
      }
      case "Const":
      case "UnOp":
      case "BinOp":
      case "Print":
        break;
      default:
        throw new Error(`interproc: unclassified instruction kind '${inst.kind}' (add a constraint arm)`);
    }
  }
  return { cs, sites };
}

function applySummary(
  sum: Summary,
  actuals: number[],
  dst: number | undefined,
  isRef: (id: number) => boolean,
  cs: C[],
  counters: { opaque: number; temp: number },
  creation: boolean
): void {
  const op = `O${counters.opaque}`;
  counters.opaque++;

  for (let i = 0; i < sum.nparams; i++) {
    if (sum.paramGlobal[i] && i < actuals.length && isRef(actuals[i])) {
      cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(actuals[i]) });
    }
  }
  for (let i = sum.nparams; i < actuals.length; i++) {
    if (isRef(actuals[i])) cs.push({ t: "Copy", d: REF_GLOBAL, s: refLocal(actuals[i]) });
  }

  for (const e of sum.fieldGlobal) {
    const comma = e.indexOf(",");
    const i = parseInt(e.slice(0, comma), 10);
    const fk = e.slice(comma + 1);
    if (i < actuals.length) {
      const t = `T${counters.temp}`;
      counters.temp++;
      cs.push({ t: "Load", d: t, b: refLocal(actuals[i]), f: fk });
      cs.push({ t: "Copy", d: REF_GLOBAL, s: t });
    }
  }
  for (const e of sum.fieldRet) {
    const comma = e.indexOf(",");
    const i = parseInt(e.slice(0, comma), 10);
    const fk = e.slice(comma + 1);
    if (i < actuals.length) {
      const t = `T${counters.temp}`;
      counters.temp++;
      cs.push({ t: "Load", d: t, b: refLocal(actuals[i]), f: fk });
      if (creation) cs.push({ t: "Copy", d: REF_GLOBAL, s: t });
      else if (dst !== undefined && isRef(dst)) cs.push({ t: "Copy", d: refLocal(dst), s: t });
    }
  }

  // Side: {ref: local} | {obj: string} | null. NOTE the `i >= 0` guard: an
  // out-of-scope param maps to `p-1` (Rust uses usize::MAX, which never passes
  // `< len`), and -1 would otherwise index actuals[-1] = undefined.
  const asBase = (s: string): { ref?: number; obj?: string } | null => {
    if (s.charCodeAt(0) === 112 /* 'p' */) {
      const i = parseInt(s.slice(1), 10);
      return i >= 0 && i < actuals.length ? { ref: actuals[i] } : null;
    }
    if (s === "I") return { obj: op };
    if (s === "X") return { obj: OBJ_EXTERNAL };
    return null; // Global
  };
  const asVal = (s: string): { ref?: number; obj?: string } | null => {
    if (s.charCodeAt(0) === 112) {
      const j = parseInt(s.slice(1), 10);
      return j >= 0 && j < actuals.length ? { ref: actuals[j] } : null;
    }
    if (s === "I") return { obj: op };
    return { obj: OBJ_EXTERNAL }; // External | Global
  };

  for (const e of sum.fields) {
    const parts = e.split(",");
    const b = asBase(parts[0]);
    const key = parts[1];
    const v = asVal(parts[2]);
    if (b !== null && v !== null) {
      if (b.ref !== undefined && v.ref !== undefined) cs.push({ t: "Store", b: refLocal(b.ref), f: key, s: refLocal(v.ref) });
      else if (b.ref !== undefined && v.obj !== undefined) cs.push({ t: "StoreLit", b: refLocal(b.ref), f: key, v: v.obj });
      else if (b.obj !== undefined && v.ref !== undefined) cs.push({ t: "StoreObj", o: b.obj, f: key, s: refLocal(v.ref) });
      else if (b.obj !== undefined && v.obj !== undefined) cs.push({ t: "AddrField", b: b.obj, f: key, v: v.obj });
    }
  }

  if (dst !== undefined && isRef(dst)) {
    for (const s of sum.ret) {
      if (s.charCodeAt(0) === 112) {
        const i = parseInt(s.slice(1), 10);
        if (i >= 0 && i < actuals.length) cs.push({ t: "Copy", d: refLocal(dst), s: refLocal(actuals[i]) });
      } else if (s === "I") {
        cs.push({ t: "Addr", r: refLocal(dst), o: op });
      } else {
        cs.push({ t: "Addr", r: refLocal(dst), o: OBJ_EXTERNAL }); // External | Global
      }
    }
  }
}

// -------------------------------- extraction --------------------------------

function solveFn(f: FnLite, summaries: (Summary | undefined)[]): { solver: Solver; sites: number[] } {
  const { cs, sites } = buildConstraints(f, summaries);
  const solver = new Solver();
  solver.solve(cs);
  return { solver, sites };
}

function extractSummary(f: FnLite, solver: Solver): Summary {
  const paramIndex = new Map<number, number>();
  f.params.forEach((p, i) => paramIndex.set(p, i));
  // Obj -> SObj
  const mapObj = (o: string): string => {
    const c = o.charCodeAt(0);
    if (c === 83 /* S */ || c === 79 /* O */ || c === 70 /* F */) return "I";
    if (o === OBJ_EXTERNAL) return "X";
    // Param
    const p = parseInt(o.slice(1), 10);
    const i = paramIndex.get(p);
    return i === undefined ? "p-1" : `p${i}`;
  };

  const global = solver.globalSet();
  const retSet = solver.fieldClosure(new Set(solver.ptClone(REF_RET)));
  const refMap = refMapOf(f);
  const isRefLike = (p: number) => refMap.get(p) ?? true;

  const paramGlobal: boolean[] = [];
  f.params.forEach((p) => {
    paramGlobal.push(isRefLike(p) && global.has(objParam(p)));
  });
  if (f.isGenerator || f.isAsync) {
    f.params.forEach((p, i) => {
      if (isRefLike(p)) paramGlobal[i] = true;
    });
  }

  const fieldGlobal = new Set<string>();
  const fieldRet = new Set<string>();
  const collectParamFields = (set: Set<string>, out: Set<string>) => {
    for (const o of set) {
      if (o.charCodeAt(0) === 70 /* F */) {
        const bar = o.indexOf("|");
        const p = parseInt(o.slice(1, bar), 10);
        const fk = o.slice(bar + 1);
        const i = paramIndex.get(p);
        if (i !== undefined) out.add(`${i},${fk}`);
      }
    }
  };
  collectParamFields(global, fieldGlobal);
  collectParamFields(retSet, fieldRet);

  const fields = new Set<string>();
  for (const [k, tgts] of solver.field) {
    const hash = k.indexOf("#");
    const so = mapObj(k.slice(0, hash));
    if (so !== "p-1") {
      const key = k.slice(hash + 1);
      for (const t of tgts) fields.add(`${so},${key},${mapObj(t)}`);
    }
  }
  const ret = new Set<string>();
  for (const o of solver.ptClone(REF_RET)) ret.add(mapObj(o));

  return { nparams: f.params.length, paramGlobal, fields, ret, fieldGlobal, fieldRet };
}

function extractEscape(f: FnLite, solver: Solver, sites: number[]): { site: number; state: string }[] {
  const global = solver.globalSet();
  const refMap = refMapOf(f);

  const aSeed = new Set(solver.ptClone(REF_RET));
  for (const p of f.params) {
    if (refMap.get(p) ?? true) {
      for (const o of solver.ptClone(refLocal(p))) aSeed.add(o);
    }
  }
  const arg = solver.fieldClosure(aSeed);

  return sites.map((site) => {
    const o = objSite(site);
    let state: string;
    if (global.has(o) || (f.isExported === true && arg.has(o))) state = "globalEscape";
    else if (arg.has(o)) state = "argEscape";
    else state = "noEscape";
    return { site, state };
  });
}

// ---------------------------------- driver ----------------------------------

export interface EscapeResult {
  version: number;
  sites: { site: number; state: string }[];
}

export function analyzeProgram(prog: Program): EscapeResult {
  const cg = buildCallGraph(prog);
  const byId = new Map<number, FnLite>();
  for (const f of prog.functions) byId.set(f.id, f as unknown as FnLite);
  let n = prog.functions.length;
  for (const f of prog.functions) if (f.id + 1 > n) n = f.id + 1;
  const summaries: (Summary | undefined)[] = [];
  for (let i = 0; i < n; i++) summaries.push(undefined);

  for (const scc of cg.order) {
    if (!isCyclic(cg, scc)) {
      const f = byId.get(scc[0]);
      if (f !== undefined) {
        const { solver } = solveFn(f, summaries);
        summaries[scc[0]] = extractSummary(f, solver);
      }
    } else {
      for (const m of scc) {
        const f = byId.get(m);
        if (f !== undefined) summaries[m] = emptySummary(f.params.length);
      }
      for (;;) {
        let changed = false;
        for (const m of scc) {
          const f = byId.get(m);
          if (f !== undefined) {
            const { solver } = solveFn(f, summaries);
            const s = extractSummary(f, solver);
            const prev = summaries[m];
            if (prev === undefined || summaryKey(prev) !== summaryKey(s)) {
              summaries[m] = s;
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
    }
  }

  const sitesOut: { site: number; state: string }[] = [];
  for (const f of prog.functions) {
    const fl = f as unknown as FnLite;
    const { solver, sites } = solveFn(fl, summaries);
    for (const e of extractEscape(fl, solver, sites)) sitesOut.push(e);
  }
  return { version: 1, sites: sitesOut };
}
