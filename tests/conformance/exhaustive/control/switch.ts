function day(n: number): string {
  switch (n) {
    case 0: return "Sun";
    case 1: case 2: case 3: case 4: case 5: return "weekday";
    case 6: return "Sat";
    default: return "?";
  }
}
function main(): void {
  console.log(day(0), day(3), day(6), day(9));
}

main();
