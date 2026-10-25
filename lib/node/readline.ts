// node:readline (docs/node_compat_design.md): an Interface that splits a
// readable stream into lines ('line' per line, 'close' at the end, the last
// unterminated line included), question/prompt over an output stream, pause
// and resume, async iteration over the lines, and the cursor functions
// (escape sequences written to a stream). Terminal mode (key-by-key editing
// with echo) is not available: with terminal true the interface still reads
// whole lines from the input.
import { EventEmitter } from "./events";
import { Readable, Sink } from "./stream";
import { StringDecoder } from "./string_decoder";
import { codedError, invalidArgType } from "./errors";
import { host } from "./host";

export interface ReadLineOptions {
  input: Readable;
  output?: Sink;
  completer?: unknown;
  terminal?: boolean;
  history?: string[];
  historySize?: number;
  removeHistoryDuplicates?: boolean;
  prompt?: string;
  crlfDelay?: number;
  escapeCodeTimeout?: number;
  tabSize?: number;
  signal?: unknown;
}
export interface Key { sequence?: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }

function useAfterClose(): Error { return codedError("ERR_USE_AFTER_CLOSE", "readline was closed"); }

export class Interface extends EventEmitter {
  readonly terminal: boolean;
  line: string = "";
  cursor: number = 0;
  history: string[] = [];
  closed: boolean = false;
  readonly historySize: number;
  readonly crlfDelay: number;
  private readonly input: Readable;
  private readonly output: Sink | undefined;
  private promptText: string;
  private lineBuffer: string = "";
  private sawReturnAt: number = 0;
  private paused: boolean = false;
  private questionCallback: ((answer: string) => void) | null = null;
  private previousPrompt: string = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly onData: (data: unknown) => void;
  private readonly onEnd: () => void;
  constructor(input: Readable | ReadLineOptions, output?: Sink, _completer?: unknown, terminal?: boolean) {
    super();
    let options: ReadLineOptions;
    if (input !== null && typeof input === "object" && !(input instanceof Readable) && (input as ReadLineOptions).input !== undefined) {
      options = input as ReadLineOptions;
    } else {
      options = { input: input as Readable, output, terminal };
    }
    if (options.input === undefined || options.input === null) throw invalidArgType("input", "an instance of Readable", options.input);
    this.input = options.input;
    this.output = options.output;
    const outIsTTY = this.output !== undefined && (this.output as unknown as { isTTY?: boolean }).isTTY === true;
    this.terminal = options.terminal === undefined ? outIsTTY : !!options.terminal;
    this.promptText = options.prompt === undefined ? "> " : options.prompt;
    this.historySize = options.historySize === undefined ? 30 : options.historySize;
    this.crlfDelay = options.crlfDelay === undefined ? 100 : Math.max(100, options.crlfDelay);
    if (Array.isArray(options.history)) this.history = options.history.slice();
    this.onData = (data: unknown): void => {
      const text = typeof data === "string" ? data : this.decoder.write(data as Uint8Array);
      this.normalWrite(text);
    };
    this.onEnd = (): void => {
      const rest = this.lineBuffer + this.decoder.end();
      if (rest.length > 0) { this.lineBuffer = ""; this.onLine(rest); }
      this.close();
    };
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.resume();
  }
  /** The lines of a chunk of input; the unterminated tail waits for more. */
  private normalWrite(chunk: string): void {
    if (chunk === "") return;
    let text = chunk;
    if (this.sawReturnAt !== 0 && Date.now() - this.sawReturnAt <= this.crlfDelay) {
      if (text.charCodeAt(0) === 10) text = text.slice(1);
      this.sawReturnAt = 0;
    }
    let hasEnding = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) { hasEnding = true; break; }
    }
    if (!hasEnding) {
      if (text.length > 0) this.lineBuffer += text;
      return;
    }
    text = this.lineBuffer + text;
    this.lineBuffer = "";
    this.sawReturnAt = text.endsWith("\r") ? Date.now() : 0;
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) { lines.push(text.slice(start, i)); start = i + 1; }
      else if (c === 13) {
        lines.push(text.slice(start, i));
        if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++;
        start = i + 1;
      }
    }
    this.lineBuffer = text.slice(start);
    for (const line of lines) this.onLine(line);
  }
  private onLine(line: string): void {
    if (this.questionCallback !== null) {
      const callback = this.questionCallback;
      this.questionCallback = null;
      this.setPrompt(this.previousPrompt);
      callback(line);
      return;
    }
    if (this.terminal && line.length > 0 && this.historySize > 0 && this.history[0] !== line) {
      this.history.unshift(line);
      if (this.history.length > this.historySize) this.history.pop();
      this.emit("history", this.history);
    }
    this.emit("line", line);
  }
  private writeOutput(text: string): void {
    if (this.output !== undefined) this.output.write(text);
  }
  setPrompt(prompt: string): void { this.promptText = prompt; }
  getPrompt(): string { return this.promptText; }
  prompt(_preserveCursor?: boolean): void {
    if (this.closed) throw useAfterClose();
    if (this.paused) this.resume();
    this.writeOutput(this.promptText);
  }
  /** Writes the query, and hands the next line to the callback instead of a 'line' event. */
  question(query: string, options: { signal?: unknown } | ((answer: string) => void), callback?: (answer: string) => void): void {
    if (typeof options === "function") callback = options;
    if (typeof callback !== "function") { if (this.closed) throw useAfterClose(); return; }
    this.askQuestion(query, callback);
  }
  /** The question itself (the promise form calls it too). */
  protected askQuestion(query: string, callback: (answer: string) => void): void {
    if (this.closed) throw useAfterClose();
    if (this.questionCallback !== null) {
      this.prompt();
      return;
    }
    this.previousPrompt = this.promptText;
    this.setPrompt(query);
    this.questionCallback = callback;
    this.prompt();
  }
  /** Data written to the interface is read as input. */
  write(data: string | Uint8Array | null | undefined, _key?: Key): void {
    if (this.paused) this.resume();
    if (data === null || data === undefined) return;
    const text = typeof data === "string" ? data : this.decoder.write(data);
    this.normalWrite(text);
  }
  pause(): this {
    if (this.paused) return this;
    this.input.pause();
    this.paused = true;
    this.emit("pause");
    return this;
  }
  resume(): this {
    if (!this.paused) return this;
    this.input.resume();
    this.paused = false;
    this.emit("resume");
    return this;
  }
  close(): void {
    if (this.closed) return;
    this.pause();
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.emit("close");
  }
  getCursorPos(): { rows: number; cols: number } {
    return { rows: 0, cols: this.promptText.length + this.cursor };
  }
  /** The lines as they arrive; the iterator ending closes the interface. */
  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, undefined> {
    const queue: string[] = [];
    let waiter: (() => void) | null = null;
    let done = this.closed;
    const wake = (): void => { if (waiter !== null) { const w = waiter; waiter = null; w(); } };
    const onLine = (line: string): void => { queue.push(line); wake(); };
    const onClose = (): void => { done = true; wake(); };
    this.on("line", onLine);
    this.on("close", onClose);
    try {
      for (;;) {
        if (queue.length > 0) { yield queue.shift() as string; continue; }
        if (done) return;
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
    } finally {
      this.removeListener("line", onLine);
      this.removeListener("close", onClose);
      this.close();
    }
  }
}

export function createInterface(input: Readable | ReadLineOptions, output?: Sink, completer?: unknown, terminal?: boolean): Interface {
  return new Interface(input, output, completer, terminal);
}

// ---- the cursor functions: escape sequences written to a stream ----
type WriteCallback = () => void;
function writeSequence(stream: Sink | null | undefined, sequence: string, callback?: WriteCallback): boolean {
  if (typeof callback !== "function") callback = undefined;
  if (stream === null || stream === undefined) {
    if (callback !== undefined) host.nextTick(callback, undefined);
    return true;
  }
  return stream.write(sequence, callback);
}
export function clearLine(stream: Sink | null | undefined, dir: number, callback?: WriteCallback): boolean {
  return writeSequence(stream, dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K", callback);
}
export function clearScreenDown(stream: Sink | null | undefined, callback?: WriteCallback): boolean {
  return writeSequence(stream, "\x1b[0J", callback);
}
export function cursorTo(stream: Sink | null | undefined, x: number, y?: number | WriteCallback, callback?: WriteCallback): boolean {
  if (typeof y === "function") { callback = y; y = undefined; }
  if (typeof x !== "number") throw invalidArgType("x", "of type number", x);
  return writeSequence(stream, typeof y !== "number" ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`, callback);
}
export function moveCursor(stream: Sink | null | undefined, dx: number, dy: number, callback?: WriteCallback): boolean {
  let sequence = "";
  if (dx < 0) sequence += `\x1b[${-dx}D`; else if (dx > 0) sequence += `\x1b[${dx}C`;
  if (dy < 0) sequence += `\x1b[${-dy}A`; else if (dy > 0) sequence += `\x1b[${dy}B`;
  return writeSequence(stream, sequence, callback);
}
/** Key events need a terminal in raw mode, which is not available: nothing is emitted. */
export function emitKeypressEvents(_stream: Readable, _iface?: Interface): void {}

const readline = { Interface, createInterface, clearLine, clearScreenDown, cursorTo, moveCursor, emitKeypressEvents };
export default readline;
