// The completion a finally block defers (a return value, a thrown value) is
// held while the finally body runs; a collection there must neither free it
// nor leave it at a moved-from address. The emitter used to keep it in a C
// local the collector does not see, so once the frame slot that produced it
// was reused, a fresh object or string was freed before it was returned.

function churn(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { const t = { a: i, b: [i, i + 1] }; s += t.b[1]; }
  return s;
}

function makeRecord(k: number): { tag: string; n: number } {
  try {
    return { tag: "made-" + k, n: k * 3 };
  } finally {
    const other = { tag: "other-" + k, n: -1 };
    const words: string[] = [];
    for (let i = 0; i < 50; i++) words.push("w" + i + other.tag);
    churn(2000 + words.length);
  }
}

function makeText(k: number): string {
  try {
    if (k >= 0) return "text-" + k + "-" + (k * 7);
    return "never";
  } finally {
    const local = ["x" + k, "y" + k];
    churn(1500 + local.length);
  }
}

function fromCatch(k: number): string[] {
  try {
    if (k % 2 === 0) throw new Error("even-" + k);
    return ["odd", "value-" + k];
  } catch (e) {
    return ["caught", (e as Error).message + "!"];
  } finally {
    const pad = { p: "pad-" + k };
    churn(1200 + pad.p.length);
  }
}

// A finally nested in a finally body: the outer return value waits while
// the inner one runs its own body.
function nested(k: number): { v: string } {
  try {
    return { v: "outer-" + k };
  } finally {
    try {
      churn(800);
    } finally {
      const z = ["inner-" + k];
      churn(900 + z.length);
    }
  }
}

function rethrown(k: number): string {
  try {
    try {
      throw { code: "E" + k, list: [k, k + 1] };
    } finally {
      const q = ["q" + k];
      churn(1000 + q.length);
    }
  } catch (e) {
    const x = e as { code: string; list: number[] };
    return x.code + "/" + x.list.join(",");
  }
}

const out: string[] = [];
for (let k = 0; k < 30; k++) {
  const r = makeRecord(k);
  const t = makeText(k);
  const c = fromCatch(k);
  const n = nested(k);
  out.push(r.tag + ":" + r.n + ":" + t + ":" + c.join("+") + ":" + n.v + ":" + rethrown(k));
}
console.log(out.slice(0, 3).join("|"));
console.log(out.length, out.join("|").length);
