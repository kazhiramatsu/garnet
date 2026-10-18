function replacementMetrics(source: string, pattern: string, replacement: string,
                            needle: string): number {
  let total = 0;
  let i = 0;
  while (i < 3) {
    const result = source.replaceAll(pattern, replacement);
    total = total + result.length + result.indexOf(needle) + result.charCodeAt(0);
    i = i + 1;
  }
  return total;
}

const sources = [
  "a-a+",
  "+a---a",
  "----",
  "plain",
  "é-漢😀-é",
  "a\0a-+",
  ("prefix-" + "a-+é😀-".repeat(4) + "-suffix").slice(7, -7),
];

for (const source of sources) {
  console.log(
    replacementMetrics(source, "-", "+", "+"),
    replacementMetrics(source, "-", "+", "-"),
    replacementMetrics(source, "-", "+", "a"),
    replacementMetrics(source, "-", "-", "-"),
    replacementMetrics(source, "a", "+", "+"),
    replacementMetrics(source, "+", "a", "a"),
    replacementMetrics(source, "é", "漢", "漢"),
    replacementMetrics(source, "漢", "é", "é"),
    replacementMetrics(source, "\ud83d", "\ude00", "\ude00"),
    replacementMetrics(source, "\0", "+", "+"),
  );
}

// Keep the generic paths covered: different widths, empty patterns, and $ tokens.
console.log(
  replacementMetrics("a-a+", "-", "++", "+"),
  replacementMetrics("a--a", "--", "+", "+"),
  replacementMetrics("a-a+", "-", "", "+"),
  replacementMetrics("a-a+", "", "+", "+"),
  replacementMetrics("a-a+", "-", "$", "$"),
  replacementMetrics("a-a+", "-", "$&", "-"),
);
