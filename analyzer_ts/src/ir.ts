/**
 * IR types for the TypeScript analyzer (self-hosting port of analyzer/).
 *
 * Source of truth: analyzer/src/escape_ir.rs (the full 57-instruction schema the
 * exporter actually emits). The older exporter/escape_ir.ts is the stale P0
 * escape-analysis projection (13 instructions) and is NOT used here.
 *
 * Strategy: this file is grown TEST-DRIVEN. We define typed interfaces only for
 * the instruction kinds the conservative emitter currently handles; every other
 * kind flows through as `RawInst` (a `{ kind, ... }` bag) and makes emit throw
 * loudly, telling us exactly what to port next. The exporter writes JSON with
 * `JSON.stringify`, so these interfaces are read directly — no deserialization.
 */

export type LocalId = number;
export type FunctionId = number;
export type FieldId = number;
export type TypeId = number;

export type RefKind = "reference" | "primitive" | "unknown";

export interface Program {
  version: number;
  fields: FieldInfo[];
  functions: FunctionDef[];
  globals?: unknown[];
  classes?: unknown[];
  // The prototype-method tables are consumed by the (currently lifted) runtime
  // preamble template, so they are not typed in detail yet.
  [extra: string]: unknown;
}

export interface FieldInfo {
  id: FieldId;
  name: string;
  declaringType: TypeId;
}

export interface FunctionDef {
  id: FunctionId;
  name?: string;
  params: LocalId[];
  ret: TypeId;
  locals: Local[];
  body: Inst[];
  isExported: boolean;
  isAsync?: boolean;
  isGenerator?: boolean;
  takesThis?: boolean;
  arity?: number;
  hasPrototype?: boolean;
  restParam?: unknown;
  paramClasses?: Record<string, unknown>;
}

export interface Local {
  id: LocalId;
  typeId: TypeId;
  refKind: RefKind;
  binding?: number;
  name?: string;
}

export interface ClassMethod {
  name: number;        // method-name id (TS_KEY_METHOD key)
  propName?: string;   // named property key (when the method has a string name)
  func: FunctionId;
  kind: string;        // "method" | "getter" | "setter" | ...
}

export interface ClassDef {
  id: number;
  name: string;
  parent: number | null;
  ownMethods: ClassMethod[];
  ownFields: FieldId[];
  instantiated: boolean;
  stable: boolean;
  /** Set when the class extends a built-in Error (0=Error,1=TypeError,…); its
   *  prototype chains to ts_error_proto(kind) rather than Object.prototype. */
  errorProtoKind?: number | null;
}

// ---- Constant values (ConstVal in escape_ir.rs) ----
export type ConstVal =
  | { kind: "Num"; value: number }
  | { kind: string; [k: string]: unknown }; // grown test-driven

// ---- Instructions ----
// Typed interfaces for the kinds the conservative emitter handles today.
export interface IConst { kind: "Const"; dst: LocalId; value: ConstVal }
export interface IBinOp { kind: "BinOp"; dst: LocalId; op: string; lhs: LocalId; rhs: LocalId }
export interface IPrint { kind: "Print"; src: LocalId }
export interface IReturn { kind: "Return"; src?: LocalId }

// Catch-all for not-yet-ported instructions: emit throws on these.
export interface RawInst { kind: string; [k: string]: unknown }

export type Inst = IConst | IBinOp | IPrint | IReturn | RawInst;
