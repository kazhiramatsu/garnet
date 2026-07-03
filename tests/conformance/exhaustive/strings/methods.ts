function main(): void {
  const s = "Hello, World!";
  console.log(s.length, s.toUpperCase(), s.toLowerCase());
  console.log(s.slice(0, 5), s.slice(7), s.substring(7, 12));
  console.log(s.indexOf("o"), s.lastIndexOf("o"), s.includes("World"));
  console.log(s.startsWith("Hello"), s.endsWith("!"), s.charAt(0), s.charCodeAt(0));
}

main();
