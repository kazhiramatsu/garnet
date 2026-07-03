function main(): void {
  const s = "  trimmed  ";
  console.log("[" + s.trim() + "]", "abc".repeat(3));
  console.log("a,b,c".split(",").join("-"), "Hello".replace("l", "L"));
  console.log("x".padStart(5, "0"), "y".padEnd(5, "-"));
}

main();
