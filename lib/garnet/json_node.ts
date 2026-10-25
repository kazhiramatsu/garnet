// garnet:json under Node (scripts/garnet_scheme_loader.mjs): the same parser
// over plain objects. A call without a schema is the plain parse; the exporter
// is not involved, so a `parse<T>(text)` validates only under garnet (a fixture
// exercises the validation with `parseWithSchema`).
import { compileSchema, parseText, parseGeneric, stringifyGeneric, type Layout, type MakeLayout } from "./json_core";

const makeLayout: MakeLayout = (keys: string[]): Layout => keys;
function makeObject(layout: Layout, values: unknown[]): unknown {
  const keys = layout as string[];
  const o: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) o[keys[i]] = values[i];
  return o;
}

export function parse<T = unknown>(text: string, schema?: string): T {
  if (schema === undefined || schema === "*") return parseGeneric(text) as T;
  return parseText(text, compileSchema(schema, makeLayout), makeObject) as T;
}
export function parseWithSchema(text: string, schema: string): unknown {
  return parseText(text, compileSchema(schema, makeLayout), makeObject);
}
export function stringify(value: unknown): string { return stringifyGeneric(value); }
export const JSON = { parse, parseWithSchema, stringify };
