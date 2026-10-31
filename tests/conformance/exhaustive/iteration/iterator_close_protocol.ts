// IteratorClose and the order of the protocol's steps in an array pattern over a value the types do not
// settle, and in the loops that share the runtime's steps: a throw while an element binds closes the
// iterator and the throw goes on, a target is evaluated before its element's step, `return` that is not
// callable or answers no object is a TypeError on a normal completion and dropped on a throw, a Proxy
// sees one read of each method, an elision leaves `value` unread.
function boom(): never {
  throw new RangeError("boom");
}
function closing(log: string[]): any {
  return {
    next() {
      return { done: false, value: undefined };
    },
    return() {
      log.push("return");
      return {};
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}

// a throw while an element binds: a default, a nested pattern, a setter
{
  const log: string[] = [];
  const it = closing(log);
  try {
    const [a = boom()] = it;
    log.push(String(a));
  } catch (e) {
    log.push("caught " + (e as Error).name);
  }
  try {
    const [[x]] = { [Symbol.iterator]() { return it; } } as any;
    log.push(String(x));
  } catch (e) {
    log.push("caught " + (e as Error).name);
  }
  const o = {
    set x(v: any) {
      boom();
    },
  };
  try {
    [o.x] = it;
  } catch (e) {
    log.push("caught " + (e as Error).name);
  }
  try {
    const [{ deep }] = { [Symbol.iterator]() { return it; } } as any;
    log.push(String(deep));
  } catch (e) {
    log.push("caught " + (e as Error).name);
  }
  console.log(log.join(","));
}

// a step that throws ends the record: no close; a throw in a `done` or `value` getter the same
{
  const log: string[] = [];
  const it: any = {
    n: 0,
    next() {
      this.n++;
      if (this.n === 1) return { done: false, value: 1 };
      if (this.n === 2) return { get done() { return boom(); }, value: 2 };
      return { done: false, get value() { return boom(); } };
    },
    return() {
      log.push("return");
      return {};
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  const risky = (v: any): any => v;
  try {
    const [a = risky(0), b = risky(0)] = it;
    log.push(String(a) + String(b));
  } catch (e) {
    log.push("caught " + (e as Error).name);
  }
  try {
    const [c = risky(0)] = it;
    log.push(String(c));
  } catch (e) {
    log.push("caught " + (e as Error).name);
  }
  console.log(log.join(","));
}

// a throw from `return` on a throw completion is dropped; on a normal one it goes on
{
  const it: any = {
    next() {
      return { done: false, value: 1 };
    },
    return() {
      throw new TypeError("from return");
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  try {
    const [a = boom()] = { [Symbol.iterator]() { return { next() { return { done: false, value: undefined }; }, return: it.return }; } } as any;
    console.log(a);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
  try {
    const [a] = it;
    console.log(a);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}

// a target's reference comes before its element's step
{
  const log: string[] = [];
  const it: any = {
    next() {
      log.push("next");
      return { done: false, value: 1 };
    },
    return() {
      log.push("return");
      return {};
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  const tgt = (): any => {
    log.push("target");
    return {};
  };
  const key = (): string => {
    log.push("key");
    return "k";
  };
  [tgt().x] = it;
  [tgt()[key()]] = it;
  let rest: any;
  const ended: any = {
    next() {
      log.push("next");
      return { done: true, value: undefined };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  [...tgt().y] = ended;
  [rest = log.push("default")] = ended;
  console.log(log.join(","), rest);
}

// `return` that is not callable, a result that is no object
{
  const run = (ret: any): string => {
    const it: any = {
      next() {
        return { done: false, value: 1 };
      },
      return: ret,
      [Symbol.iterator]() {
        return this;
      },
    };
    try {
      const [a] = it;
      return "ok " + a;
    } catch (e) {
      return (e as Error).constructor.name;
    }
  };
  console.log(run(5), run(() => 5), run(() => ({})), run(undefined), run(null), run("x"), run(() => undefined));
}

// the same at a loop over a class iterator: a `break` is a normal completion for the close, a throw
// in the body is not (what `return` does then is dropped), and a `next` that throws closes nothing
class Closer {
  log: string[] = [];
  ret: any;
  failAt = -1;
  n = 0;
  constructor(ret: any) {
    this.ret = ret;
  }
  next(): IteratorResult<number> {
    if (this.n++ === this.failAt) throw new SyntaxError("from next");
    return { done: false, value: this.n };
  }
  get return(): any {
    this.log.push("return read");
    return this.ret;
  }
  [Symbol.iterator](): Closer {
    return this;
  }
}
function breakOut(ret: any): string {
  try {
    for (const x of new Closer(ret)) {
      break;
    }
    return "ok";
  } catch (e) {
    return (e as Error).constructor.name;
  }
}
console.log(breakOut(5), breakOut(() => 5), breakOut(() => ({})), breakOut(undefined), breakOut(null));
function throwOut(ret: any): string {
  try {
    for (const x of new Closer(ret)) {
      throw new RangeError("body");
    }
    return "ok";
  } catch (e) {
    return (e as Error).constructor.name + " " + (e as Error).message;
  }
}
console.log(throwOut(5), throwOut(() => 5), throwOut(() => { throw new TypeError("close"); }));
function nextThrows(): string {
  const c = new Closer(() => ({}));
  c.failAt = 2;
  try {
    for (const x of c) {
      c.log.push("v" + x);
    }
    return "ok";
  } catch (e) {
    return (e as Error).message + " " + c.log.join("|");
  }
}
console.log(nextThrows());
function returnOut(): string {
  const c = new Closer(() => ({}));
  const run = (): number => {
    for (const x of c) {
      return x;
    }
    return -1;
  };
  return run() + " " + c.log.join("|");
}
console.log(returnOut());

// a Proxy iterator sees one read of `next` and of `return`
{
  const seen: string[] = [];
  const p: any = new Proxy(
    {
      next() {
        return { done: false, value: 1 };
      },
    },
    {
      get(t, k, r) {
        seen.push(String(k));
        return Reflect.get(t, k, r);
      },
    },
  );
  const [a] = { [Symbol.iterator]() { return p; } } as any;
  console.log(a, seen.join("|"));
}

// an array handed back as the iterator is stepped by its `next`
{
  const it: any = [10, 20];
  it.next = () => ({ done: false, value: 1 });
  it.return = () => ({});
  const [a] = { [Symbol.iterator]() { return it; } } as any;
  const out: number[] = [];
  for (const x of { [Symbol.iterator]() { return it; } } as any) {
    out.push(x);
    if (out.length === 2) break;
  }
  console.log(a, out.join(","));
}

// an elision takes `done` and leaves `value` unread
{
  const log: string[] = [];
  const it: any = {
    next() {
      return {
        get done() {
          log.push("done");
          return false;
        },
        get value() {
          log.push("value");
          return 1;
        },
      };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  const [, b] = it;
  console.log(b, log.join(","));
}

// functions are objects to the protocol, a Symbol is not
{
  const fn: any = function () {};
  fn[Symbol.iterator] = function* () {
    yield 4;
  };
  const [a] = fn;
  const out: number[] = [];
  for (const x of fn) out.push(x);
  console.log(a, out.join(","));
  const stepper: any = function () {};
  stepper.next = () => ({ done: true, value: undefined });
  const [b] = { [Symbol.iterator]() { return stepper; } } as any;
  console.log(b);
  const resultFn: any = () => 0;
  (resultFn as any).done = false;
  (resultFn as any).value = 9;
  const [c] = { [Symbol.iterator]() { return { next() { return resultFn; } }; } } as any;
  console.log(c);
  for (const bad of [Symbol("s"), () => Symbol("r")]) {
    try {
      const source: any = typeof bad === "function"
        ? { [Symbol.iterator]() { return { next: bad }; } }
        : { [Symbol.iterator]() { return bad; } };
      const [d] = source;
      console.log(d);
    } catch (e) {
      console.log((e as Error).constructor.name);
    }
  }
}

// a result that is no object, through a class iterator's typed driver
class NoResult {
  next(): any {
    return 5;
  }
  [Symbol.iterator](): NoResult {
    return this;
  }
}
try {
  const [a] = new NoResult();
  console.log(a);
} catch (e) {
  console.log((e as Error).constructor.name);
}
try {
  for (const x of new NoResult()) {
    console.log(x);
    break;
  }
} catch (e) {
  console.log((e as Error).constructor.name);
}

// patterns over strings: the first code points of a long string, surrogate pairs
{
  const long = "😀".repeat(1000) + "z";
  const [a, , b] = long;
  const anyLong: any = long;
  const [c] = anyLong;
  const [d, ...e] = "😀xy";
  console.log(a, b, c, d, e.join(""));
}

// assignment patterns nested in another pattern, or a loop's target: the protocol over the value
{
  let a: any, b: any;
  [[a, b]] = [new Set([1, 2])];
  console.log(a, b);
  for ([a, b] of [new Set([3, 4])]) console.log(a, b);
  ({ p: [a, b] } = { p: "😀x" });
  console.log(a, b);
  [[a], [b]] = [[5], [6]];
  console.log(a, b);
  let c = 1;
  let d = 2;
  [c, d] = [d, c];
  console.log(c, d);
  const o: { x?: number; y?: number } = {};
  [[o.x], { y: o.y }] = [new Set([7]), { y: 8 }];
  console.log(o.x, o.y);
  [a, ...b] = "xyz";
  console.log(a, b.join("+"));
}

// an array with an own [Symbol.iterator]
{
  const x: any = [1, 2];
  x[Symbol.iterator] = function* () {
    yield 9;
  };
  const [y] = x;
  console.log(y, [...x].join(","));
  const out: number[] = [];
  for (const v of x) out.push(v);
  console.log(out.join(","));
  const named: any = [1, 2];
  named.tag = "t";
  const [p, q] = named;
  console.log(p, q, [...named].join(","));
}
