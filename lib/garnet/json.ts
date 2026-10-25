// garnet:json — typed JSON (docs/typed_json_design.md).
//
// `parse<T>(text)` parses `text` as a value of `T`: the exporter compiles `T`
// to a schema and passes it as the second argument, the parser validates the
// text against it as it goes (a TypeError names the path and the kinds:
// "$.user.tags[2] must be number, received string"; a missing required
// property "$.id is missing"; malformed text a SyntaxError with the position)
// and builds each object in the literal layout of the type's properties, in
// declaration order; properties the type does not declare are dropped. `T` is
// an explicit type argument or the contextual type (`const u: User =
// JSON.parse(text)`); without either, or for `any`/`unknown`, the result is the
// plain parse. `parseWithSchema` takes the schema string explicitly.
//
// This file is the garnet binding (the runtime's `__garnet_json`); under Node
// the same module name resolves to json_node.ts, which builds plain objects
// (scripts/garnet_scheme_loader.mjs).
import { compileSchema, parseText, parseGeneric, stringifyGeneric, type Layout, type MakeLayout } from "./json_core";

declare global {
  var __garnet_json: {
    layout(keys: string[]): unknown;
    makeObject(layout: unknown, values: unknown[]): unknown;
    flat(text: string): string;
  };
}

// the host's functions, read once (a global's property lookup per object is measurable)
const hostLayout = __garnet_json.layout;
const hostMakeObject = __garnet_json.makeObject;
const hostFlat = __garnet_json.flat;
const makeLayout: MakeLayout = (keys: string[]): Layout => hostLayout(keys);
function makeObject(layout: Layout, values: unknown[]): unknown { return hostMakeObject(layout, values); }

/** Parses `text` as a value of `T` (the exporter supplies `schema` from `T`). */
export function parse<T = unknown>(text: string, schema?: string): T {
  if (schema === undefined || schema === "*") return parseGeneric(text) as T;
  return parseText(hostFlat(text), compileSchema(schema, makeLayout), makeObject) as T;
}

/** Parses `text` as a value of the schema string (the form the exporter derives). */
export function parseWithSchema(text: string, schema: string): unknown {
  return parseText(hostFlat(text), compileSchema(schema, makeLayout), makeObject);
}

/** `JSON.stringify(value)`. */
export function stringify(value: unknown): string { return stringifyGeneric(value); }

/** The namespace form: `import { JSON } from "garnet:json"; JSON.parse<User>(text)`. */
export const JSON = { parse, parseWithSchema, stringify };
