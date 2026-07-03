function main(): void {
  const s = "Hello, World";
  console.log(s.length, s.toUpperCase(), s.slice(7), s.indexOf("World"));
  console.log(s.split(", ").join("|"), `${s}!`.repeat(2));
}

main();
