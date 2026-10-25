// node:readline/promises: the Interface whose question returns a promise, and
// the Readline class that batches cursor movements.
import { Interface as CallbackInterface, ReadLineOptions, clearLine, clearScreenDown, cursorTo, moveCursor } from "../readline";
import { Readable, Sink } from "../stream";

export class Interface extends CallbackInterface {
  question(query: string, options?: { signal?: unknown }): Promise<string>;
  question(query: string, options: { signal?: unknown } | ((answer: string) => void), callback?: (answer: string) => void): void;
  question(query: string, options?: { signal?: unknown } | ((answer: string) => void), callback?: (answer: string) => void): Promise<string> | void {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") { this.askQuestion(query, cb); return; }
    return new Promise<string>((resolve) => { this.askQuestion(query, (answer: string) => resolve(answer)); });
  }
}
export function createInterface(input: Readable | ReadLineOptions, output?: Sink, completer?: unknown, terminal?: boolean): Interface {
  return new Interface(input, output, completer, terminal);
}
/** Cursor operations collected and written together by commit(). */
export class Readline {
  private readonly stream: Sink;
  private readonly autoCommit: boolean;
  private pending: string[] = [];
  constructor(stream: Sink, options?: { autoCommit?: boolean }) {
    this.stream = stream;
    this.autoCommit = options !== undefined && options.autoCommit === true;
  }
  private add(sequence: string): this {
    if (this.autoCommit) this.stream.write(sequence);
    else this.pending.push(sequence);
    return this;
  }
  cursorTo(x: number, y?: number): this { return this.add(typeof y !== "number" ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`); }
  moveCursor(dx: number, dy: number): this {
    let sequence = "";
    if (dx < 0) sequence += `\x1b[${-dx}D`; else if (dx > 0) sequence += `\x1b[${dx}C`;
    if (dy < 0) sequence += `\x1b[${-dy}A`; else if (dy > 0) sequence += `\x1b[${dy}B`;
    return this.add(sequence);
  }
  clearLine(dir: number): this { return this.add(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K"); }
  clearScreenDown(): this { return this.add("\x1b[0J"); }
  commit(): Promise<void> {
    const text = this.pending.join("");
    this.pending = [];
    return new Promise<void>((resolve) => { if (text === "") resolve(); else this.stream.write(text, () => resolve()); });
  }
  rollback(): this { this.pending = []; return this; }
}
const promises = { Interface, createInterface, Readline, clearLine, clearScreenDown, cursorTo, moveCursor };
export default promises;
