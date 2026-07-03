/**
 * Devirtualization pass — the TypeScript port of analyzer/src/devirt.rs.
 * Runs BEFORE emit (and before the future escape port), rewriting every
 * `Method { recvClass, method, recvStable }` callee into:
 *     Direct{func}   — one reachable impl (CHA refined by RTA)
 *     Method{...}    — several reachable impls / untrusted receiver (kept
 *                      dynamic: codegen does the prototype-chain lookup)
 *     Unknown        — no reachable impl (unresolvable)
 *
 * Soundness guards mirror devirt.rs: a receiver reached via `any`/cast
 * (recvStable=false), an unstable receiver class, or any unstable candidate in
 * the closed-world subtree keeps the dynamic path. A polymorphic-class `new`
 * (`new (cond ? A : B)` collapsing to one static type, NewDynamic{poly:true})
 * taints its dataflow: method calls on tainted receivers stay dynamic, and a
 * tainted value ESCAPING the function is a LOUD compile error (a downstream
 * Direct devirtualization could silently miscompile).
 */
import { Program } from "./ir";

interface MethodDefD { name: number; func: number; kind: string }
interface ClassDefD {
  id: number;
  parent: number | null;
  stable?: boolean;
  instantiated?: boolean;
  ownMethods: MethodDefD[];
}

export class ClassTable {
  private byId = new Map<number, ClassDefD>();
  constructor(classes: ClassDefD[]) {
    for (const c of classes) this.byId.set(c.id, c);
  }
  private get(c: number): ClassDefD | undefined {
    return this.byId.get(c);
  }
  private chainUp(c: number): number[] {
    const v: number[] = [];
    let cur: number | null | undefined = c;
    while (cur !== null && cur !== undefined) {
      v.push(cur);
      cur = this.get(cur)?.parent;
    }
    return v;
  }
  private chainDown(c: number): number[] {
    return this.chainUp(c).reverse();
  }
  /** All classes whose up-chain contains `c` (closed world), ascending id
   *  (mirrors the BTreeMap key order in devirt.rs). */
  private subclasses(c: number): number[] {
    return [...this.byId.keys()].sort((a, b) => a - b).filter((k) => this.chainUp(k).includes(c));
  }
  private resolve(c: number, name: number): number | undefined {
    for (const id of this.chainUp(c)) {
      const cls = this.get(id);
      const m = cls?.ownMethods.find((m) => m.name === name);
      if (m) return m.func;
    }
    return undefined;
  }
  /** The set of concrete implementations reachable from recvClass (sorted asc,
   *  deduped — mirrors the BTreeSet in devirt.rs). */
  impls(recvClass: number, method: number, useRta: boolean): number[] {
    let cands = this.subclasses(recvClass).filter((c) => !useRta || (this.get(c)?.instantiated ?? false));
    if (cands.length === 0) cands = [recvClass];
    const set = new Set<number>();
    for (const c of cands) {
      const f = this.resolve(c, method);
      if (f !== undefined) set.add(f);
    }
    return [...set].sort((a, b) => a - b);
  }
  /** Core decision: "direct" -> single impl, "virtual" -> several impls,
   *  "dynamic" -> untrusted/unstable/missing. Mirrors ClassTable::devirtualize. */
  devirtualize(recvClass: number, method: number, recvStable: boolean, useRta: boolean): { kind: "direct"; func: number } | { kind: "virtual" } | { kind: "dynamic" } {
    const stableSelf = this.get(recvClass)?.stable ?? false;
    if (!recvStable || !stableSelf) return { kind: "dynamic" };
    let candidates = this.subclasses(recvClass).filter((c) => !useRta || (this.get(c)?.instantiated ?? false));
    if (candidates.length === 0) candidates = [recvClass];
    if (candidates.some((c) => !(this.get(c)?.stable ?? false))) return { kind: "dynamic" };
    const impls = new Set<number>();
    for (const c of candidates) {
      const f = this.resolve(c, method);
      if (f !== undefined) impls.add(f);
    }
    if (impls.size === 0) return { kind: "dynamic" };
    if (impls.size === 1) return { kind: "direct", func: [...impls][0] };
    return { kind: "virtual" };
  }
}

/** Flatten all instructions (recursing into Loop/If/TryCatch bodies). */
function flattenInsts(body: any[], out: any[]): void {
  for (const inst of body) {
    out.push(inst);
    if (inst.kind === "Loop") {
      flattenInsts(inst.condBody ?? [], out);
      flattenInsts(inst.body ?? [], out);
    } else if (inst.kind === "If") {
      flattenInsts(inst.thenBody ?? [], out);
      flattenInsts(inst.elseBody ?? [], out);
    } else if (inst.kind === "TryCatch") {
      flattenInsts(inst.tryBody ?? [], out);
      flattenInsts(inst.catchBody ?? [], out);
      flattenInsts(inst.finallyBody ?? [], out);
    }
  }
}

/** Locals at which a poly-tainted value would ESCAPE the function's tracked
 *  dataflow. Mirrors devirt.rs's exhaustive escape_locals: kinds listed as
 *  read-only/control contribute nothing; an UNKNOWN kind throws loudly rather
 *  than silently under-approximating (Rust gets this safety from match
 *  exhaustiveness; we get it from the default arm). */
const NO_ESCAPE_KINDS = new Set([
  "Copy", "ConstructResult",
  "AllocObject", "AllocArray", "LoadBuiltinFn", "LoadField", "LoadElem",
  "LoadIndex", "LoadFieldDynamic", "LoadGlobal", "Const", "BinOp", "UnOp",
  "ArrayLen", "StringLen", "GenericLen", "HasField", "HasFieldDynamic",
  "DeleteField", "ArraySlice", "ObjectRest", "ObjectCopyProps", "GetProto",
  "LoadClassProto", "NewMap", "NewSet", "Print", "Break", "Continue",
  "Loop", "If", "TryCatch",
]);

function escapeLocals(inst: any): number[] {
  if (NO_ESCAPE_KINDS.has(inst.kind)) return [];
  switch (inst.kind) {
    case "NewDynamic":
      return [inst.callee, ...(inst.args ?? [])];
    case "Call": {
      const v: number[] = [...(inst.args ?? [])];
      const k = inst.callee?.kind;
      if (k === "Method") {
        // receiver forced Dynamic below — sound, not an escape
      } else if (k === "Value") {
        v.push(inst.callee.local);
        if (inst.recv !== undefined) v.push(inst.recv);
      } else {
        if (inst.recv !== undefined) v.push(inst.recv);
      }
      return v;
    }
    case "CallSpread": {
      const v: number[] = (inst.argSpecs ?? []).map((a: any) => a.local);
      const k = inst.callee?.kind;
      if (k === "Method") {
        // sound
      } else if (k === "Value") {
        v.push(inst.callee.local);
        if (inst.recv !== undefined) v.push(inst.recv);
      } else {
        if (inst.recv !== undefined) v.push(inst.recv);
      }
      return v;
    }
    case "CallBuiltin":
      return [inst.recv, ...(inst.args ?? [])];
    case "CallBuiltinStatic":
      if (inst.builtin === "instanceof" || inst.builtin === "instanceof.dyn") return [];
      return [...(inst.args ?? [])];
    case "StoreField": case "StoreElem": case "StoreIndex": case "StoreFieldDynamic":
    case "StoreGlobal": case "ArrayPush": case "ArrayPushAll": case "StoreProtoMethod":
    case "StoreMethod":
      return [inst.src];
    case "AllocClosure": case "AllocClassValue":
      return (inst.captures ?? []).map((c: any) => c.cell);
    case "Return":
      return inst.src !== undefined ? [inst.src] : [];
    case "Throw":
      return [inst.src];
    case "Yield": case "Await":
      return [inst.operand];
    case "SetProto":
      return [inst.obj, inst.proto];
    case "LoadMethodValue":
      return [inst.recv];
    default:
      throw new Error(`devirt poly-taint: unclassified instruction kind '${inst.kind}' (add to escapeLocals)`);
  }
}

/** Poly-tainted locals of one function: seed at NewDynamic{poly}, propagate
 *  bidirectionally over Copy / ConstructResult to a fixpoint, then LOUD-FAIL if
 *  any tainted value reaches an escape position. */
function computePolyTaint(fn: { body: any[] }): Set<number> {
  const insts: any[] = [];
  flattenInsts(fn.body, insts);
  const tainted = new Set<number>();
  for (const i of insts) if (i.kind === "NewDynamic" && i.poly === true) tainted.add(i.dst);
  if (tainted.size === 0) return tainted;
  for (;;) {
    let changed = false;
    for (const i of insts) {
      if (i.kind === "Copy") {
        if (tainted.has(i.src) && !tainted.has(i.dst)) { tainted.add(i.dst); changed = true; }
        if (tainted.has(i.dst) && !tainted.has(i.src)) { tainted.add(i.src); changed = true; }
      } else if (i.kind === "ConstructResult") {
        if ((tainted.has(i.inst) || tainted.has(i.ret)) && !tainted.has(i.dst)) { tainted.add(i.dst); changed = true; }
      }
    }
    if (!changed) break;
  }
  for (const i of insts) {
    for (const l of escapeLocals(i)) {
      if (tainted.has(l)) {
        throw new Error(
          "unsupported: a polymorphic class value (new of `cond ? A : B` where A and B are structurally identical) escapes its constructing function. Only intra-function use is supported."
        );
      }
    }
  }
  return tainted;
}

function rewriteBody(body: any[], table: ClassTable, useRta: boolean, tainted: Set<number>): void {
  for (const inst of body) {
    if (inst.kind === "Call" && inst.callee?.kind === "Method") {
      const { recvClass, method, recvStable } = inst.callee;
      const recvTainted = inst.recv !== undefined && tainted.has(inst.recv);
      const disp = recvTainted
        ? ({ kind: "dynamic" } as const)
        : table.devirtualize(recvClass, method, recvStable, useRta);
      if (disp.kind === "direct") {
        inst.callee = { kind: "Direct", func: disp.func };
      } else if (disp.kind === "virtual") {
        const funcs = table.impls(recvClass, method, useRta);
        if (funcs.length === 1) {
          inst.callee = { kind: "Direct", func: funcs[0] };
        } else if (funcs.length === 0) {
          inst.callee = { kind: "Unknown" };
        }
        // else: genuine polymorphism — keep the dynamic Method callee (each
        // instance's prototype holds its own override; a Set would mis-pick).
      }
      // dynamic: keep the Method callee (codegen does the proto-chain lookup).
    } else if (inst.kind === "Loop") {
      rewriteBody(inst.condBody ?? [], table, useRta, tainted);
      rewriteBody(inst.body ?? [], table, useRta, tainted);
    } else if (inst.kind === "If") {
      rewriteBody(inst.thenBody ?? [], table, useRta, tainted);
      rewriteBody(inst.elseBody ?? [], table, useRta, tainted);
    } else if (inst.kind === "TryCatch") {
      rewriteBody(inst.tryBody ?? [], table, useRta, tainted);
      rewriteBody(inst.catchBody ?? [], table, useRta, tainted);
      rewriteBody(inst.finallyBody ?? [], table, useRta, tainted);
    }
  }
}

/** Rewrite all Method callees in place (CHA + RTA + poly-taint guard). */
export function runDevirt(prog: Program, useRta: boolean): void {
  const table = new ClassTable((prog.classes ?? []) as unknown as ClassDefD[]);
  for (const fn of prog.functions) {
    const tainted = computePolyTaint(fn as unknown as { body: any[] });
    rewriteBody((fn as unknown as { body: any[] }).body, table, useRta, tainted);
  }
}
