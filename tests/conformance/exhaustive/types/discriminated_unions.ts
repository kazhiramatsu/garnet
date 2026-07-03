type Shape =
  | { kind: "circle"; r: number }
  | { kind: "rect"; w: number; h: number }
  | { kind: "tri"; base: number; height: number };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle": return Math.round(s.r * s.r * 3);
    case "rect": return s.w * s.h;
    case "tri": return (s.base * s.height) / 2;
  }
}

type Result = { ok: true; value: number } | { ok: false; error: string };
function unwrap(r: Result): number { return r.ok ? r.value : -1; }

function main(): void {
  const shapes: Shape[] = [
    { kind: "circle", r: 2 },
    { kind: "rect", w: 3, h: 4 },
    { kind: "tri", base: 6, height: 5 },
  ];
  console.log(shapes.map(area).join(","));   // 12,12,15
  console.log(unwrap({ ok: true, value: 7 }), unwrap({ ok: false, error: "x" })); // 7 -1
}
main();
