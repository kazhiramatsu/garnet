enum Color { Red, Green, Blue }
enum Status { Active = 1, Inactive = 2, Pending = 4 }
enum Dir { Up = "UP", Down = "DOWN" }

function name(c: Color): string {
  switch (c) { case Color.Red: return "r"; case Color.Green: return "g"; default: return "b"; }
}

function main(): void {
  console.log(Color.Red, Color.Green, Color.Blue);     // 0 1 2
  console.log(Status.Active | Status.Pending);          // 5
  console.log(Dir.Up, Dir.Down);                        // UP DOWN
  console.log(name(Color.Blue));                        // b
  console.log(Color[0], Color[2]);                      // Red Blue (reverse map)
  const arr = [Color.Red, Color.Green, Color.Blue];
  console.log(arr.map(name).join(""));                  // rgb
}
main();
