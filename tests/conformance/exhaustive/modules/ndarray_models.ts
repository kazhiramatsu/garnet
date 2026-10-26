// garnet:ndarray driving two recurrent networks (DeepLearningJS's rnn.js and lstm.js rewritten over
// typed storage): training by backpropagation through time for a few epochs and predicting a sine
// wave; every printed prediction must agree with Node to the last bit (the module's float64
// kernels, the seeded generator, and Math's V8 implementations).
import { NDArray, Matrix, Vector, Random, zeros, ones, dot, add, sub, mul, outer, concat, slice, flatten, map, generate, sum, max, div, exp } from "garnet:ndarray";

interface Activation {
  readonly name: string;
  forward<R extends number>(x: NDArray<R>): NDArray<R>;
  grad<R extends number>(x: NDArray<R>): NDArray<R>;
}
function elementwise(name: string, f: (x: number) => number, df: (x: number) => number): Activation {
  return {
    name,
    forward: <R extends number>(x: NDArray<R>): NDArray<R> => map(x, f),
    grad: <R extends number>(x: NDArray<R>): NDArray<R> => map(x, df),
  };
}
const sigmoidOf = (x: number): number => 1 / (1 + Math.exp(-x));
const linear: Activation = elementwise("linear", (x) => x, () => 1);
const relu: Activation = elementwise("relu", (x) => (x < 0 ? 0 : x), (x) => (x < 0 ? 0 : 1));
const lrelu: Activation = elementwise("lrelu", (x) => (x < 0 ? 0.01 * x : x), (x) => (x < 0 ? 0.01 : 1));
const sigmoid: Activation = elementwise("sigmoid", sigmoidOf, (x) => { const s = sigmoidOf(x); return s * (1 - s); });
const tanh: Activation = elementwise("tanh", (x) => Math.tanh(x), (x) => { const t = Math.tanh(x); return 1 - t * t; });
/** softmax over a vector; the gradient is the diagonal s(1 - s), the usual elementwise shortcut. */
const softmax: Activation = {
  name: "softmax",
  forward: <R extends number>(x: NDArray<R>): NDArray<R> => {
    const e = exp(sub(x, max(x)));
    return div(e, sum(e)) as NDArray<R>;
  },
  grad: <R extends number>(x: NDArray<R>): NDArray<R> => {
    const s = softmax.forward(x);
    return map(s, (v) => v * (1 - v));
  },
};

interface Series { x: Matrix; y: Matrix }
function loadData(n: number, rng: Random): Series {
  const TIME_STEP = 0.1;
  const all = generate([n + 1, 1], (i) => Math.sin(i * TIME_STEP * Math.PI) + 0.1 * rng.uniform(-1, 1));
  const x = generate([n, 1], (i) => all.item(i));
  const y = generate([n, 1], (i) => all.item(i + 1));
  return { x, y };
}

interface RnnUnits { s: Matrix; u: Matrix; y: Matrix; v: Matrix }
interface RnnGrad { U: Matrix; V: Matrix; W: Matrix; b: Vector; c: Vector }

class RNN {
  U: Matrix;   // input -> hidden
  V: Matrix;   // hidden -> output
  W: Matrix;   // hidden -> hidden
  b: Vector;   // hidden bias
  c: Vector;   // output bias
  constructor(readonly nIn: number, readonly nHidden: number, readonly nOut: number, readonly truncatedTime: number = 3,
              readonly learningRate: number = 0.1, readonly activation: Activation = tanh, rng: Random = new Random(0)) {
    const rIn = Math.sqrt(1 / nIn), rHidden = Math.sqrt(1 / nHidden);
    this.U = rng.uniform(-rIn, rIn, [nHidden, nIn]);
    this.V = rng.uniform(-rHidden, rHidden, [nOut, nHidden]);
    this.W = rng.uniform(-rHidden, rHidden, [nHidden, nHidden]);
    this.b = zeros([nHidden]);
    this.c = zeros([nOut]);
  }
  /** x: one row per time step. */
  forward(x: Matrix): RnnUnits {
    const T = x.shape[0];
    const s = zeros([T, this.nHidden]), u = zeros([T, this.nHidden]);
    const y = zeros([T, this.nOut]), v = zeros([T, this.nOut]);
    let prev: Vector = zeros([this.nHidden]);
    for (let t = 0; t < T; t++) {
      const ut = add(add(dot(this.U, x.row(t)), dot(this.W, prev)), this.b);
      const st = this.activation.forward(ut);
      const vt = add(dot(this.V, st), this.c);
      u.row(t).assign(ut); s.row(t).assign(st); v.row(t).assign(vt); y.row(t).assign(linear.forward(vt));
      prev = st;
    }
    return { s, u, y, v };
  }
  backward(x: Matrix, label: Matrix): RnnGrad {
    let dU = zeros([this.nHidden, this.nIn]), dV = zeros([this.nOut, this.nHidden]), dW = zeros([this.nHidden, this.nHidden]);
    let db = zeros([this.nHidden]), dc = zeros([this.nOut]);
    const T = x.shape[0];
    const { s, u, y, v } = this.forward(x);
    const eo = mul(sub(y, label), linear.grad(v));
    const eh = zeros([T, this.nHidden]);
    for (let t = T - 1; t >= 0; t--) {
      dV = add(dV, outer(eo.row(t), s.row(t)));
      dc = add(dc, eo.row(t));
      eh.row(t).assign(mul(dot(eo.row(t), this.V), this.activation.grad(u.row(t))));
      for (let z = 0; z < this.truncatedTime; z++) {
        if (t - z < 0) break;
        dU = add(dU, outer(eh.row(t - z), x.row(t - z)));
        db = add(db, eh.row(t - z));
        if (t - z - 1 >= 0) {
          dW = add(dW, outer(eh.row(t - z), s.row(t - z - 1)));
          eh.row(t - z - 1).assign(mul(dot(eh.row(t - z), this.W), this.activation.grad(u.row(t - z - 1))));
        }
      }
    }
    return { U: dU, V: dV, W: dW, b: db, c: dc };
  }
  sgd(x: Matrix, label: Matrix, learningRate: number = this.learningRate): void {
    const g = this.backward(x, label);
    this.U = sub(this.U, mul(learningRate, g.U));
    this.V = sub(this.V, mul(learningRate, g.V));
    this.W = sub(this.W, mul(learningRate, g.W));
    this.b = sub(this.b, mul(learningRate, g.b));
    this.c = sub(this.c, mul(learningRate, g.c));
  }
  predict(x: Matrix): Matrix {
    return this.forward(x).y;
  }
}

interface Gates { a: Matrix; i: Matrix; f: Matrix; o: Matrix }
interface LstmUnits { gates: Gates; pre: Gates; c: Matrix; h: Matrix; y: Matrix; preY: Matrix }
interface LstmGrad { W: Matrix; V: Matrix; b: Vector }

class LSTM {
  Wc: Matrix; Wi: Matrix; Wf: Matrix; Wo: Matrix;   // input -> gates
  Uc: Matrix; Ui: Matrix; Uf: Matrix; Uo: Matrix;   // hidden -> gates
  bc: Vector; bi: Vector; bf: Vector; bo: Vector;   // gate biases
  V: Matrix;                                        // hidden -> output
  b: Vector;                                        // output bias
  constructor(readonly nIn: number, readonly nHidden: number, readonly nOut: number, readonly learningRate: number = 0.1,
              readonly activation: Activation = tanh, rng: Random = new Random(0)) {
    const rIn = Math.sqrt(1 / nIn), rHidden = Math.sqrt(1 / nHidden);
    this.Wc = rng.uniform(-rIn, rIn, [nHidden, nIn]);
    this.Wi = rng.uniform(-rIn, rIn, [nHidden, nIn]);
    this.Wf = rng.uniform(-rIn, rIn, [nHidden, nIn]);
    this.Wo = rng.uniform(-rIn, rIn, [nHidden, nIn]);
    this.Uc = rng.uniform(-rHidden, rHidden, [nHidden, nHidden]);
    this.Ui = rng.uniform(-rHidden, rHidden, [nHidden, nHidden]);
    this.Uf = rng.uniform(-rHidden, rHidden, [nHidden, nHidden]);
    this.Uo = rng.uniform(-rHidden, rHidden, [nHidden, nHidden]);
    this.bc = zeros([nHidden]); this.bi = zeros([nHidden]); this.bf = zeros([nHidden]); this.bo = zeros([nHidden]);
    this.V = rng.uniform(-rHidden, rHidden, [nOut, nHidden]);
    this.b = zeros([nOut]);
  }
  private gateMatrices(T: number): Gates {
    return { a: zeros([T, this.nHidden]), i: zeros([T, this.nHidden]), f: zeros([T, this.nHidden]), o: zeros([T, this.nHidden]) };
  }
  forward(x: Matrix): LstmUnits {
    const T = x.shape[0];
    const pre = this.gateMatrices(T), gates = this.gateMatrices(T);
    const c = zeros([T, this.nHidden]), h = zeros([T, this.nHidden]);
    const y = zeros([T, this.nOut]), preY = zeros([T, this.nOut]);
    let hPrev: Vector = zeros([this.nHidden]);
    let cPrev: Vector | null = null;
    for (let t = 0; t < T; t++) {
      const xt = x.row(t);
      const pa = add(add(dot(this.Wc, xt), dot(this.Uc, hPrev)), this.bc);
      const pi = add(add(dot(this.Wi, xt), dot(this.Ui, hPrev)), this.bi);
      const pf = add(add(dot(this.Wf, xt), dot(this.Uf, hPrev)), this.bf);
      const po = add(add(dot(this.Wo, xt), dot(this.Uo, hPrev)), this.bo);
      const at = this.activation.forward(pa), it = sigmoid.forward(pi), ft = sigmoid.forward(pf), ot = sigmoid.forward(po);
      const ct: Vector = cPrev === null ? mul(it, at) : add(mul(it, at), mul(ft, cPrev));
      const ht = mul(ot, this.activation.forward(ct));
      const py = add(dot(this.V, ht), this.b);
      pre.a.row(t).assign(pa); pre.i.row(t).assign(pi); pre.f.row(t).assign(pf); pre.o.row(t).assign(po);
      gates.a.row(t).assign(at); gates.i.row(t).assign(it); gates.f.row(t).assign(ft); gates.o.row(t).assign(ot);
      c.row(t).assign(ct); h.row(t).assign(ht); preY.row(t).assign(py); y.row(t).assign(linear.forward(py));
      hPrev = ht; cPrev = ct;
    }
    return { gates, pre, c, h, y, preY };
  }
  backward(x: Matrix, label: Matrix): LstmGrad {
    const T = x.shape[0];
    const H = this.nHidden, Z = this.nIn + this.nHidden + 1;
    let dV = zeros([this.nOut, this.nHidden]), db = zeros([this.nOut]);
    let dW = zeros([4 * H, Z]);
    const { gates, pre, c, h, y, preY } = this.forward(x);
    const deltaO = sub(y, label);
    const deltaH = mul(sub(y, label), linear.grad(preY));
    const ec = zeros([T, H]);                 // the cell error, accumulated from t + 1
    const one = ones([1]);
    for (let t = T - 1; t >= 0; t--) {
      dV = add(dV, outer(deltaO.row(t), h.row(t)));
      db = add(db, deltaO.row(t));
      const eh = dot(deltaH.row(t), this.V);
      const eo = mul(eh, this.activation.forward(c.row(t)));
      const ect = add(ec.row(t), mul(mul(eh, gates.o.row(t)), this.activation.grad(c.row(t))));
      ec.row(t).assign(ect);
      let ef: Vector = zeros([H]);
      if (t !== 0) {
        ec.row(t - 1).assign(mul(ect, gates.f.row(t)));
        ef = mul(ect, c.row(t - 1));
      }
      const ei = mul(ect, gates.a.row(t));
      const ea = mul(ect, gates.i.row(t));
      const es = concat([
        mul(ea, this.activation.grad(pre.a.row(t))),
        mul(ei, sigmoid.grad(pre.i.row(t))),
        mul(ef, sigmoid.grad(pre.f.row(t))),
        mul(eo, sigmoid.grad(pre.o.row(t))),
      ]);
      const hPrev: Vector = t === 0 ? zeros([H]) : h.row(t - 1);
      const z = concat([x.row(t), hPrev, one]);
      dW = add(dW, outer(es, z));
    }
    return { W: dW, V: dV, b: db };
  }
  sgd(x: Matrix, label: Matrix, learningRate: number = this.learningRate): void {
    const g = this.backward(x, label);
    const H = this.nHidden, nIn = this.nIn;
    const cols = { W: [0, nIn] as const, U: [nIn, nIn + H] as const, b: [nIn + H, nIn + H + 1] as const };
    const rows = (k: number): readonly [number, number] => [k * H, (k + 1) * H];
    const step = (w: Matrix, k: number, c: readonly [number, number]): Matrix => sub(w, mul(learningRate, slice(g.W, rows(k), c)));
    const stepB = (b: Vector, k: number): Vector => sub(b, mul(learningRate, flatten(slice(g.W, rows(k), cols.b))));
    this.Wc = step(this.Wc, 0, cols.W); this.Wi = step(this.Wi, 1, cols.W); this.Wf = step(this.Wf, 2, cols.W); this.Wo = step(this.Wo, 3, cols.W);
    this.Uc = step(this.Uc, 0, cols.U); this.Ui = step(this.Ui, 1, cols.U); this.Uf = step(this.Uf, 2, cols.U); this.Uo = step(this.Uo, 3, cols.U);
    this.bc = stepB(this.bc, 0); this.bi = stepB(this.bi, 1); this.bf = stepB(this.bf, 2); this.bo = stepB(this.bo, 3);
    const T = x.shape[0];
    this.V = sub(this.V, mul(learningRate / T, g.V));
    this.b = sub(this.b, mul(learningRate / T, g.b));
  }
  predict(x: Matrix): Matrix {
    return this.forward(x).y;
  }
}

function trainAndPredict(name: string, epochs: number, train: (x: Matrix, y: Matrix) => void, predict: (x: Matrix) => Matrix, rng: Random, steps: number): void {
  const TRAIN_NUM = 20, TEST_NUM = 6;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const data = loadData(TRAIN_NUM, rng);
    train(data.x, data.y);
  }
  let testX = loadData(TEST_NUM, rng).x;
  let output: Matrix = testX;
  for (let i = 0; i < steps; i++) {
    output = predict(testX);
    testX = concat([testX, output.row(output.shape[0] - 1).reshape([1, 1])]);
  }
  const out: string[] = [];
  for (let i = TEST_NUM; i < testX.shape[0] - 1; i++) out.push(String(output.at(i, 0)));
  console.log(name + " " + out.join(" "));
}
function main(): void {
  const rng = new Random(1234);
  const lstm = new LSTM(1, 6, 1, 0.1, tanh, rng);
  trainAndPredict("lstm", 25, (x, y) => lstm.sgd(x, y), (x) => lstm.predict(x), rng, 12);
  const rnn = new RNN(1, 4, 1, 3, 0.01, tanh, rng);
  trainAndPredict("rnn", 15, (x, y) => rnn.sgd(x, y), (x) => rnn.predict(x), rng, 8);
  const lrelu2 = new RNN(1, 3, 1, 2, 0.01, lrelu, rng);
  trainAndPredict("rnn-lrelu", 5, (x, y) => lrelu2.sgd(x, y), (x) => lrelu2.predict(x), rng, 4);
  console.log([sigmoid.name, relu.forward(generate([3], (i) => i - 1)).toString(), softmax.forward(generate([3], (i) => i)).toString(), softmax.grad(generate([2], (i) => i)).toString(), linear.grad(zeros([2])).toString()].join(" "));
}
main();
