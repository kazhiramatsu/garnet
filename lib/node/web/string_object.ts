// The String wrapper object (docs/web_fetch_api_design.md): `new String(v)` constructs this class
// through the prelude's `__garnet_StringObject`. Its prototype chain reaches `String.prototype`,
// so `instanceof String` holds; `typeof` is "object"; `toString` / `valueOf` give the primitive
// (template literals, `+`, `String()` and comparisons take them); properties can be added, as
// hono's `HtmlEscapedString` does. Index access is not modelled; the common String methods delegate.

export class StringObject {
  #v: string;
  constructor(value?: unknown) {
    this.#v = value === undefined ? "" : String(value);
  }
  toString(): string { return this.#v; }
  valueOf(): string { return this.#v; }
  toJSON(): string { return this.#v; }
  get length(): number { return this.#v.length; }
  charAt(i: number): string { return this.#v.charAt(i); }
  charCodeAt(i: number): number { return this.#v.charCodeAt(i); }
  indexOf(s: string, from?: number): number { return this.#v.indexOf(s, from); }
  includes(s: string, from?: number): boolean { return this.#v.includes(s, from); }
  startsWith(s: string, from?: number): boolean { return this.#v.startsWith(s, from); }
  endsWith(s: string, end?: number): boolean { return this.#v.endsWith(s, end); }
  slice(a?: number, b?: number): string { return this.#v.slice(a, b); }
  substring(a: number, b?: number): string { return this.#v.substring(a, b); }
  toUpperCase(): string { return this.#v.toUpperCase(); }
  toLowerCase(): string { return this.#v.toLowerCase(); }
  trim(): string { return this.#v.trim(); }
  split(sep: string, limit?: number): string[] { return this.#v.split(sep, limit); }
  concat(...parts: string[]): string { return this.#v.concat(...parts); }
  repeat(n: number): string { return this.#v.repeat(n); }
  [Symbol.iterator](): IterableIterator<string> { return this.#v[Symbol.iterator](); }
}
Object.setPrototypeOf(StringObject.prototype, String.prototype);

export { StringObject as __garnet_StringObject };
