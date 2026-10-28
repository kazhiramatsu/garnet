// Searches: a case-insensitive alternation over log text, Unicode property classes with
// matchAll over mixed-script text, a backtracking alternation, and `search` / `match`
// (docs/regexp_vm_design.md, the R2 kernels).
const severity = /error|warning|fatal/i;
const capitalized = /\p{Lu}\p{Ll}+/gu;
const nested = /(?:a|b)*c(?:d|e)+$/;
const vowelRuns = /[aeiou]{2,}/g;
const text = [
  "2024-01-01 INFO server started on port 8080",
  "2024-01-01 Warning: disk usage at 91 percent",
  "2024-01-01 ERROR connection reset by peer",
  "Ο Οδυσσέας και η Πηνελόπη, Tokyo Osaka Nagoya, Zürich München",
  "ababababababababababcdede",
  "ababababababababababcx",
  "the quick brown fox jumps over the lazy dog, aeiou queue",
];
function main(): void {
  let sum = 0;
  for (let round = 0; round < 25000; round++) {
    for (let i = 0; i < text.length; i++) {
      const s = text[i];
      if (severity.test(s)) sum += 1;
      let caps = 0;
      for (const m of s.matchAll(capitalized)) caps += m[0].length;
      sum = (sum + caps) | 0;
      if (nested.test(s)) sum += 5;
      sum = (sum + s.search(vowelRuns) + 1) | 0;
      const runs = s.match(vowelRuns);
      if (runs !== null) sum = (sum + runs.length) | 0;
    }
  }
  console.log(sum);
}
main();
