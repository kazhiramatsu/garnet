import type { Options } from "./options";
import { Kind } from "./ast";
export const defaults: Options = { kind: Kind.Html, name: "parser" };
export function describe(): string { return Kind[defaults.kind]; }
