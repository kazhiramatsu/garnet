const enum Const { A = 10, B = 20, C = A + B }
enum Computed { X = 1, Y = X << 1, Z = Y << 1, W = X | Z }
enum Mixed { Zero, One, Ten = 10, Eleven }

function inFn(): number {
  enum Local { P = 3, Q = 4 }
  return Local.P * Local.Q + (Local[3] === "P" ? 100 : 0);
}

enum Captured { A = 5, B = 7 }
function useCaptured(): number { return Captured.A + Captured.B; }

function main(): void {
  console.log(Const.A + Const.B + Const.C);          // 10+20+30 = 60
  console.log(Computed.X, Computed.Y, Computed.Z, Computed.W); // 1 2 4 5
  console.log(Mixed.Zero, Mixed.One, Mixed.Ten, Mixed.Eleven); // 0 1 10 11
  console.log(inFn());                                // 12 + 100 = 112
  console.log(useCaptured());                         // 12
  console.log(Object.keys(Captured).sort().join(",")); // 5,7,A,B
}
main();
