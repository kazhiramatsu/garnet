// The Fetch standard's objects (docs/web_fetch_api_design.md): Headers, Request, Response,
// FormData (text fields) and fetch over the runtime's transport. The prelude installs them as the
// globals when the program names them; under the V8 oracle the globals are Node's own (undici),
// whose behaviour these follow.
import { URL, URLSearchParams } from "../url";

declare global {
  /** The runtime's transport (ts_rt.c ts_fetch over libcurl): the exporter lowers a call of this
   *  name from a lib module to the `global.fetch` builtin, which also links the fetch runtime. */
  function __garnet_fetch(url: string, init: RawFetchInit): Promise<RawFetchResponse>;
}
interface RawFetchInit { method: string; headers: Record<string, string>; body?: string; signal?: unknown; timeoutMs?: number }
interface RawFetchResponse { status: number; ok: boolean; headers: Record<string, string>; __body: string }

// ---- Headers ----

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function headerName(name: unknown): string {
  const s = String(name);
  if (!TOKEN_RE.test(s)) throw new TypeError(`Header name must be a valid HTTP token ["${s}"]`);
  return s.toLowerCase();
}
function isHttpWhitespace(c: number): boolean { return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d; }
function headerValue(value: unknown): string {
  const s = String(value);
  let a = 0, b = s.length;
  while (a < b && isHttpWhitespace(s.charCodeAt(a))) a++;
  while (b > a && isHttpWhitespace(s.charCodeAt(b - 1))) b--;
  const v = s.slice(a, b);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0 || c === 0x0a || c === 0x0d) throw new TypeError(`Invalid header value: "${v}"`);
  }
  return v;
}
export type HeadersInit = Headers | Iterable<[string, string]> | Record<string, string>;

export class Headers {
  #map = new Map<string, string[]>();
  #guard: "none" | "immutable" = "none";
  constructor(init?: HeadersInit) {
    if (init === undefined) return;
    if (init === null) throw new TypeError("Headers constructor: Argument 1 could not be converted to one of: sequence<sequence<ByteString>>, record<ByteString, ByteString>.");
    if (init instanceof Headers) {
      for (const [k, v] of init.#raw()) this.append(k, v);
      return;
    }
    if (typeof init !== "object" && typeof init !== "function") throw new TypeError("Failed to construct 'Headers': The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.");
    const iterable = (init as { [Symbol.iterator]?: unknown })[Symbol.iterator];
    if (typeof iterable === "function") {
      for (const pair of init as Iterable<unknown>) {
        if (pair === null || typeof pair !== "object") throw new TypeError("Failed to construct 'Headers': The provided value cannot be converted to a sequence.");
        const items = Array.isArray(pair) ? pair : Array.from(pair as Iterable<unknown>);
        if (items.length !== 2) throw new TypeError("Failed to construct 'Headers': Each header pair must be a name/value tuple");
        this.append(items[0] as string, items[1] as string);
      }
      return;
    }
    const rec = init as Record<string, unknown>;
    for (const k of Object.keys(rec)) this.append(k, rec[k] as string);
  }
  /** the entries as stored: one per value, in insertion order (the constructor's copy) */
  *#raw(): IterableIterator<[string, string]> {
    for (const [k, vals] of this.#map) for (const v of vals) yield [k, v];
  }
  #checkGuard(): void {
    if (this.#guard === "immutable") throw new TypeError("immutable");
  }
  append(name: string, value: string): void {
    const n = headerName(name), v = headerValue(value);
    this.#checkGuard();
    const cur = this.#map.get(n);
    if (cur === undefined) this.#map.set(n, [v]); else cur.push(v);
  }
  set(name: string, value: string): void {
    const n = headerName(name), v = headerValue(value);
    this.#checkGuard();
    this.#map.set(n, [v]);
  }
  delete(name: string): void {
    const n = headerName(name);
    this.#checkGuard();
    this.#map.delete(n);
  }
  get(name: string): string | null {
    const cur = this.#map.get(headerName(name));
    return cur === undefined ? null : cur.join(", ");
  }
  has(name: string): boolean { return this.#map.has(headerName(name)); }
  getSetCookie(): string[] {
    const cur = this.#map.get("set-cookie");
    return cur === undefined ? [] : cur.slice();
  }
  *entries(): IterableIterator<[string, string]> {
    const names = Array.from(this.#map.keys()).sort();
    for (const n of names) {
      const vals = this.#map.get(n)!;
      if (n === "set-cookie") { for (const v of vals) yield [n, v]; }
      else yield [n, vals.join(", ")];
    }
  }
  *keys(): IterableIterator<string> { for (const [k] of this.entries()) yield k; }
  *values(): IterableIterator<string> { for (const [, v] of this.entries()) yield v; }
  forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) callback.call(thisArg, v, k, this);
  }
  [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return "Headers"; }
  /** the guard of a fetch response's headers (an internal of this module) */
  static __setImmutable(h: Headers): void { h.#guard = "immutable"; }
  static __hasHeader(h: Headers, lowerName: string): boolean { return h.#map.has(lowerName); }
}

// ---- bodies ----

type BodyKind = "null" | "string" | "bytes";
interface BodyData { kind: BodyKind; str: string; bytes: Uint8Array | null; type: string | null }
const NO_BODY: BodyData = { kind: "null", str: "", bytes: null, type: null };

/** A body and its state. A Request made from a Request, or a Response made from another's
 *  `body`, reads through the source (Node pipes the source's stream through a proxy): the source
 *  is locked (another construction from it, or a read of it, is a TypeError) and a read of the
 *  proxy marks the source used; `bodyUsed` reports a read, not the lock. */
class BodyCell {
  data: BodyData;
  used = false;
  locked = false;
  source: BodyCell | null = null;
  constructor(data: BodyData, source: BodyCell | null = null) { this.data = data; this.source = source; }
  get unusable(): boolean { return this.used || this.locked; }
  /** a proxy of this cell for another object: this one is locked when it has a body, and a
   *  Request made from a Request reports the source used at once (Node's pipe disturbs its
   *  stream); a stream handed to another Response is only locked until that one is read */
  proxy(markUsed: boolean): BodyCell {
    if (this.data.kind === "null") return new BodyCell(NO_BODY);
    this.locked = true;
    if (markUsed) this.used = true;
    return new BodyCell(this.data, this);
  }
  markUsed(): void {
    for (let c: BodyCell | null = this; c !== null; c = c.source) c.used = true;
  }
}
/** An opaque stand-in for a body's ReadableStream (streams are a later slice): another Request
 *  or Response takes the cell; a reader is not available. */
export class BodyStream {
  __cell: BodyCell;
  constructor(cell: BodyCell) { this.__cell = cell; }
  get locked(): boolean { return false; }
  getReader(): never { throw new TypeError("ReadableStream readers are not supported yet"); }
  get [Symbol.toStringTag](): string { return "ReadableStream"; }
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  const src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}
let boundaryCounter = 0;
function multipartOf(form: FormData): BodyData {
  const boundary = "----formdata-garnet-" + String(1e12 + (Date.now() % 1e12)) + String(++boundaryCounter);
  let s = "";
  for (const [name, value] of form) {
    s += `--${boundary}\r\nContent-Disposition: form-data; name="${name.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22")}"\r\n\r\n${value}\r\n`;
  }
  s += `--${boundary}--\r\n`;
  return { kind: "string", str: s, bytes: null, type: `multipart/form-data; boundary=${boundary}` };
}
function extractBody(init: unknown): BodyData {
  if (init === null || init === undefined) return NO_BODY;
  if (typeof init === "string") return { kind: "string", str: init, bytes: null, type: "text/plain;charset=UTF-8" };
  if (init instanceof BodyStream) return init.__cell.data;
  if (init instanceof URLSearchParams) return { kind: "string", str: init.toString(), bytes: null, type: "application/x-www-form-urlencoded;charset=UTF-8" };
  if (init instanceof FormData) return multipartOf(init);
  if (init instanceof ArrayBuffer) return { kind: "bytes", str: "", bytes: bytesOf(new Uint8Array(init)), type: null };
  if (ArrayBuffer.isView(init)) return { kind: "bytes", str: "", bytes: bytesOf(init), type: null };
  return { kind: "string", str: String(init), bytes: null, type: "text/plain;charset=UTF-8" };
}
function bodyText(d: BodyData): string {
  if (d.kind === "bytes") return new TextDecoder().decode(d.bytes!);
  return d.str;
}
function bodyBytes(d: BodyData): Uint8Array {
  if (d.kind === "bytes") { const out = new Uint8Array(d.bytes!.length); out.set(d.bytes!); return out; }
  return new TextEncoder().encode(d.str);
}
function copyBody(d: BodyData): BodyData {
  if (d.kind === "bytes") return { kind: "bytes", str: "", bytes: bodyBytes(d), type: d.type };
  return d;
}
/** The common body state of a Request and a Response. */
class BodyMixin {
  __cell: BodyCell = new BodyCell(NO_BODY);
  __headers!: Headers;
  get __body(): BodyData { return this.__cell.data; }
  get __used(): boolean { return this.__cell.used; }
  get bodyUsed(): boolean { return this.__cell.used; }
  get body(): BodyStream | null { return this.__cell.data.kind === "null" ? null : new BodyStream(this.__cell); }
  get __locked(): boolean { return this.__cell.locked; }
  __consume(): BodyData {
    if (this.__cell.unusable) throw new TypeError("Body is unusable: Body has already been read");
    if (this.__cell.data.kind !== "null") this.__cell.markUsed();
    return this.__cell.data;
  }
  async text(): Promise<string> { return bodyText(this.__consume()); }
  async json(): Promise<unknown> { return JSON.parse(bodyText(this.__consume())); }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const b = bodyBytes(this.__consume());
    const out = new ArrayBuffer(b.length);
    new Uint8Array(out).set(b);
    return out;
  }
  async bytes(): Promise<Uint8Array> { return bodyBytes(this.__consume()); }
  async formData(): Promise<FormData> {
    const type = this.__headers.get("content-type") ?? "";
    const text = bodyText(this.__consume());
    const lower = type.toLowerCase();
    const form = new FormData();
    if (lower.startsWith("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(text)) form.append(k, v);
      return form;
    }
    const m = /boundary=("?)([^";]+)\1/i.exec(type);
    if (lower.startsWith("multipart/form-data") && m !== null) {
      const boundary = "--" + m[2];
      const parts = text.split(boundary);
      for (let i = 1; i < parts.length; i++) {
        let part = parts[i];
        if (part.startsWith("--")) break;
        if (part.startsWith("\r\n")) part = part.slice(2);
        const sep = part.indexOf("\r\n\r\n");
        if (sep < 0) continue;
        const head = part.slice(0, sep), body = part.slice(sep + 4, part.endsWith("\r\n") ? part.length - 2 : part.length);
        const nm = /name="([^"]*)"/i.exec(head);
        if (nm === null) continue;
        form.append(nm[1], body);
      }
      return form;
    }
    throw new TypeError("Could not parse content as FormData.");
  }
}

// ---- FormData (text fields) ----

export class FormData {
  #entries: [string, string][] = [];
  append(name: string, value: unknown): void { this.#entries.push([String(name), String(value)]); }
  set(name: string, value: unknown): void {
    const n = String(name), v = String(value);
    const i = this.#entries.findIndex((e) => e[0] === n);
    if (i < 0) { this.#entries.push([n, v]); return; }
    this.#entries[i] = [n, v];
    this.#entries = this.#entries.filter((e, j) => j <= i || e[0] !== n);
  }
  get(name: string): string | null {
    const n = String(name);
    for (const e of this.#entries) if (e[0] === n) return e[1];
    return null;
  }
  getAll(name: string): string[] {
    const n = String(name);
    const out: string[] = [];
    for (const e of this.#entries) if (e[0] === n) out.push(e[1]);
    return out;
  }
  has(name: string): boolean { const n = String(name); return this.#entries.some((e) => e[0] === n); }
  delete(name: string): void { const n = String(name); this.#entries = this.#entries.filter((e) => e[0] !== n); }
  *entries(): IterableIterator<[string, string]> { for (const e of this.#entries) yield [e[0], e[1]]; }
  *keys(): IterableIterator<string> { for (const e of this.#entries) yield e[0]; }
  *values(): IterableIterator<string> { for (const e of this.#entries) yield e[1]; }
  forEach(callback: (value: string, key: string, parent: FormData) => void, thisArg?: unknown): void {
    for (const e of this.#entries) callback.call(thisArg, e[1], e[0], this);
  }
  [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return "FormData"; }
}

// ---- Request ----

export interface RequestInit {
  method?: string; headers?: HeadersInit; body?: unknown; signal?: unknown; cache?: string; credentials?: string;
  mode?: string; redirect?: string; referrer?: string; referrerPolicy?: string; integrity?: string; keepalive?: boolean;
  duplex?: string; timeoutMs?: number;
}
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
function normalizeMethod(m: unknown): string {
  const s = String(m);
  if (!TOKEN_RE.test(s)) throw new TypeError(`'${s}' is not a valid HTTP method.`);
  const u = s.toUpperCase();
  if (u === "CONNECT" || u === "TRACE" || u === "TRACK") throw new TypeError(`'${s}' HTTP method is unsupported.`);
  return (u === "DELETE" || u === "GET" || u === "HEAD" || u === "OPTIONS" || u === "POST" || u === "PUT") ? u : s;
}
function parseRequestURL(input: unknown): string {
  const text = String(input);
  let u: URL;
  try { u = new URL(text); } catch { throw new TypeError(`Failed to parse URL from ${text}`); }
  if (u.username !== "" || u.password !== "") throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${text}`);
  return u.href;
}
function freshSignal(): unknown { return new AbortController().signal; }

export class Request extends BodyMixin {
  #url: string;
  #method: string;
  #signal: unknown;
  #cache = "default";
  #credentials = "same-origin";
  #mode = "cors";
  #redirect = "follow";
  #referrer = "about:client";
  #referrerPolicy = "";
  #integrity = "";
  #keepalive = false;
  #duplex = "half";
  #timeoutMs: number | undefined = undefined;
  constructor(input: string | URL | Request, init?: RequestInit) {
    super();
    const opts: RequestInit = init === undefined || init === null ? {} : init;
    if (typeof init !== "object" && init !== undefined) throw new TypeError("Failed to construct 'Request': The provided value is not of type 'RequestInit'.");
    let method = "GET";
    let headers: Headers | undefined;
    let cell: BodyCell = new BodyCell(NO_BODY);
    let signal: unknown = undefined;
    if (input instanceof Request) {
      if (input.__cell.unusable) throw new TypeError("Cannot construct a Request with a Request object that has already been used.");
      this.#url = input.#url;
      method = input.#method;
      headers = new Headers(input.__headers);
      cell = opts.body === undefined ? input.__cell.proxy(true) : input.__cell;
      signal = input.#signal;
      this.#cache = input.#cache; this.#credentials = input.#credentials; this.#mode = input.#mode; this.#redirect = input.#redirect;
      this.#referrer = input.#referrer; this.#referrerPolicy = input.#referrerPolicy; this.#integrity = input.#integrity;
      this.#keepalive = input.#keepalive; this.#duplex = input.#duplex; this.#timeoutMs = input.#timeoutMs;
    } else {
      this.#url = parseRequestURL(input);
    }
    if (opts.method !== undefined) method = normalizeMethod(opts.method);
    if (opts.headers !== undefined) headers = new Headers(opts.headers);
    if (headers === undefined) headers = new Headers();
    if (opts.body !== undefined && opts.body !== null) {
      if (method === "GET" || method === "HEAD") throw new TypeError("Request with GET/HEAD method cannot have body.");
      const body = extractBody(opts.body);
      if (body.type !== null && !headers.has("content-type")) headers.append("content-type", body.type);
      cell = opts.body instanceof BodyStream ? opts.body.__cell.proxy(false) : new BodyCell(body);
    } else if (opts.body === null) {
      cell = new BodyCell(NO_BODY);
    }
    if (opts.signal !== undefined) {
      if (opts.signal !== null && (typeof opts.signal !== "object" || !("aborted" in (opts.signal as object)))) throw new TypeError("Failed to construct 'Request': member signal is not of type AbortSignal.");
      signal = opts.signal === null ? undefined : opts.signal;
    }
    if (opts.cache !== undefined) this.#cache = String(opts.cache);
    if (opts.credentials !== undefined) this.#credentials = String(opts.credentials);
    if (opts.mode !== undefined) this.#mode = String(opts.mode);
    if (opts.redirect !== undefined) this.#redirect = String(opts.redirect);
    if (opts.referrer !== undefined) this.#referrer = String(opts.referrer);
    if (opts.referrerPolicy !== undefined) this.#referrerPolicy = String(opts.referrerPolicy);
    if (opts.integrity !== undefined) this.#integrity = String(opts.integrity);
    if (opts.keepalive !== undefined) this.#keepalive = Boolean(opts.keepalive);
    if (opts.duplex !== undefined) this.#duplex = String(opts.duplex);
    if (opts.timeoutMs !== undefined) this.#timeoutMs = Number(opts.timeoutMs);
    this.#method = method;
    this.__headers = headers;
    this.__cell = cell;
    this.#signal = signal === undefined ? freshSignal() : signal;
  }
  get url(): string { return this.#url; }
  get method(): string { return this.#method; }
  get headers(): Headers { return this.__headers; }
  get signal(): unknown { return this.#signal; }
  get cache(): string { return this.#cache; }
  get credentials(): string { return this.#credentials; }
  get destination(): string { return ""; }
  get integrity(): string { return this.#integrity; }
  get keepalive(): boolean { return this.#keepalive; }
  get mode(): string { return this.#mode; }
  get redirect(): string { return this.#redirect; }
  get referrer(): string { return this.#referrer; }
  get referrerPolicy(): string { return this.#referrerPolicy; }
  get duplex(): string { return this.#duplex; }
  get __timeoutMs(): number | undefined { return this.#timeoutMs; }
  clone(): Request {
    if (this.__cell.unusable) throw new TypeError("Request.clone: Body has already been consumed.");
    const r = new Request(this, { body: null });   // the fields copied, the body not proxied (Node tees the stream)
    r.__cell = new BodyCell(copyBody(this.__body));
    return r;
  }
  get [Symbol.toStringTag](): string { return "Request"; }
}

// ---- Response ----

export interface ResponseInit { status?: number; statusText?: string; headers?: HeadersInit }
function reasonPhrase(s: unknown): string {
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (!(c === 0x09 || (c >= 0x20 && c <= 0x7e) || (c >= 0x80 && c <= 0xff))) throw new TypeError("Invalid statusText");
  }
  return t;
}

export class Response extends BodyMixin {
  #status = 200;
  #statusText = "";
  #type = "default";
  #url = "";
  #redirected = false;
  constructor(body?: unknown, init?: ResponseInit | Response) {
    super();
    let status = 200, statusText = "";
    let headers: Headers;
    if (init !== undefined && init !== null) {
      if (typeof init !== "object") throw new TypeError("Failed to construct 'Response': The provided value is not of type 'ResponseInit'.");
      const o = init as { status?: unknown; statusText?: unknown; headers?: unknown };
      if (o.status !== undefined) {
        const n = Number(o.status);
        if (!Number.isInteger(n) || n < 200 || n > 599) throw new RangeError(`init["status"] must be in the range of 200 to 599, inclusive.`);
        status = n;
      }
      if (o.statusText !== undefined) statusText = reasonPhrase(o.statusText);
      headers = o.headers === undefined || o.headers === null ? new Headers() : new Headers(o.headers as HeadersInit);
    } else {
      headers = new Headers();
    }
    const data = extractBody(body);
    if (data.kind !== "null" && NULL_BODY_STATUS.has(status)) throw new TypeError("Response with null body status cannot have body");
    if (data.type !== null && !headers.has("content-type")) headers.append("content-type", data.type);
    this.#status = status;
    this.#statusText = statusText;
    this.__headers = headers;
    this.__cell = body instanceof BodyStream ? body.__cell.proxy(false) : new BodyCell(data);
  }
  static json(data: unknown, init?: ResponseInit): Response {
    const text = JSON.stringify(data);
    if (text === undefined) throw new TypeError("Response.json: data is not JSON serializable");
    const headers = new Headers(init === undefined ? undefined : init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(text, { status: init === undefined ? undefined : init.status, statusText: init === undefined ? undefined : init.statusText, headers });
  }
  static redirect(url: string | URL, status: number = 302): Response {
    const s = Number(status);
    if (s !== 301 && s !== 302 && s !== 303 && s !== 307 && s !== 308) throw new RangeError("Invalid status code " + String(status));
    let href: string;
    try { href = new URL(String(url)).href; } catch { throw new TypeError(`Failed to parse URL from ${String(url)}`); }
    const r = new Response(null, { status: s });
    r.__headers.set("location", href);
    return r;
  }
  static error(): Response {
    const r = new Response(null);
    r.#status = 0;
    r.#type = "error";
    Headers.__setImmutable(r.__headers);
    return r;
  }
  /** a fetch's response: the transport's status, its headers (immutable) and body, the request's URL */
  static __fromTransport(status: number, headers: Headers, body: string, url: string): Response {
    const r = new Response(null);
    r.#status = status;
    r.#url = url;
    r.__headers = headers;
    r.__cell = new BodyCell(body.length === 0 && (status === 204 || status === 304) ? NO_BODY : { kind: "string", str: body, bytes: null, type: null });
    Headers.__setImmutable(headers);
    return r;
  }
  get status(): number { return this.#status; }
  get statusText(): string { return this.#statusText; }
  get ok(): boolean { return this.#status >= 200 && this.#status <= 299; }
  get headers(): Headers { return this.__headers; }
  get type(): string { return this.#type; }
  get url(): string { return this.#url; }
  get redirected(): boolean { return this.#redirected; }
  clone(): Response {
    if (this.__cell.unusable) throw new TypeError("Response.clone: Body has already been consumed.");
    const r = new Response(null);
    r.#status = this.#status; r.#statusText = this.#statusText; r.#type = this.#type; r.#url = this.#url; r.#redirected = this.#redirected;
    r.__headers = new Headers(this.__headers);
    r.__cell = new BodyCell(copyBody(this.__body));
    return r;
  }
  get [Symbol.toStringTag](): string { return "Response"; }
}

// ---- fetch ----

export async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) headers[k] = v;
  const raw: RawFetchInit = { method: req.method, headers, signal: req.signal };
  if (req.__body.kind !== "null") raw.body = bodyText(req.__body);
  if (req.__timeoutMs !== undefined) raw.timeoutMs = req.__timeoutMs;
  const res = await __garnet_fetch(req.url, raw);
  const h = new Headers();
  const rh = res.headers;
  for (const k of Object.keys(rh)) h.append(k, rh[k]);
  return Response.__fromTransport(res.status, h, res.__body, req.url);
}
