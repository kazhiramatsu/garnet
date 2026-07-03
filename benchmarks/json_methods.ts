class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
function main(): void {
  // stringify primitives, arrays, objects
  console.log(JSON.stringify(42));                  // 42
  console.log(JSON.stringify("hi"));                // "hi"
  console.log(JSON.stringify(true));                // true
  console.log(JSON.stringify([1, 2, 3]));           // [1,2,3]
  const p = new Point(3, 4);
  console.log(JSON.stringify(p));                   // {"x":3,"y":4}
  console.log(JSON.stringify([p, p]));              // [{"x":3,"y":4},{"x":3,"y":4}]
  // Object.keys / values / entries
  console.log(Object.keys(p).join(","));            // x,y
  console.log(Object.values(p).join(","));          // 3,4
  // parse
  const o = JSON.parse('{"x":10,"y":20}');
  console.log(o.x + o.y);                            // 30
  const arr = JSON.parse('[1,2,3,4]');
  console.log(arr.length);                           // 4
  // round trip
  console.log(JSON.stringify(JSON.parse('{"a":1,"b":[2,3]}'))); // {"a":1,"b":[2,3]}
  // escaping
  console.log(JSON.stringify("a\"b\nc"));            // "a\"b\nc"
}

main();
