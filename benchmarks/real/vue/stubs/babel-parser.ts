// A stand-in for @babel/parser with the package's own types (<clone>/garnet-types): the browser configuration
// of vue's compiler (garnet-stubs/globals.ts) never parses an expression with babel (identifiers are not
// prefixed), so a call here is a setup bug.
import type { parse as realParse, parseExpression as realParseExpression } from "../garnet-types/node_modules/@babel/parser/typings/babel-parser";
export type { ParserOptions, ParserPlugin, ParseResult } from "../garnet-types/node_modules/@babel/parser/typings/babel-parser";
export function parse(..._args: Parameters<typeof realParse>): ReturnType<typeof realParse> {
  throw new Error("garnet vue benchmark: @babel/parser is not available");
}
export function parseExpression(..._args: Parameters<typeof realParseExpression>): ReturnType<typeof realParseExpression> {
  throw new Error("garnet vue benchmark: @babel/parser is not available");
}
