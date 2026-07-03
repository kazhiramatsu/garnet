enum Color { Red, Green, Blue }
enum Dir { N = "N", S = "S", E = "E", W = "W" }
type ColorName = keyof typeof Color;
const weights: Record<Color, number> = { [Color.Red]: 1, [Color.Green]: 2, [Color.Blue]: 3 };
function colorWeight(c: Color): number { return weights[c]; }
function isColor(n: number): n is Color { return n === Color.Red || n === Color.Green || n === Color.Blue; }
function main(): void {
  console.log(colorWeight(Color.Green));                       // 2
  const m = new Map<Dir, number>();
  m.set(Dir.N, 0); m.set(Dir.S, 180);
  console.log(m.get(Dir.N), m.get(Dir.S));                     // 0 180
  console.log(isColor(1), isColor(9));                         // true false
  const names: ColorName[] = ["Red", "Green", "Blue"];
  console.log(names.map(n => Color[n]).join(","));             // 0,1,2
  let total = 0;
  for (const c of [Color.Red, Color.Green, Color.Blue]) total += colorWeight(c);
  console.log(total);                                          // 6
}
main();
