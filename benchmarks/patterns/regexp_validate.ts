// Anchored validation patterns with alternations and counted groups (emails, URLs, IPv4
// addresses, ISO dates) over a mixed list of strings: `test` on fresh strings every round
// (docs/regexp_vm_design.md, the R2 kernels).
const email = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const url = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const isoDate = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?$/;
const samples = [
  "kaz@example.com", "first.last+tag@sub.example.co.jp", "not an email", "x@y", "a@b.c",
  "https://example.com/path?q=1", "HTTP://EXAMPLE.ORG", "ftp://nope", "http:// space",
  "192.168.0.1", "256.1.1.1", "10.0.0", "0.0.0.0", "255.255.255.255",
  "2024-02-29", "2024-13-01", "2024-02-29T23:59:59", "2024-02-29T24:00", "1999-12-31T00:00",
];
function main(): void {
  let ok = 0;
  for (let round = 0; round < 40000; round++) {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] + (round & 1 ? "" : "");
      if (email.test(s)) ok += 1;
      if (url.test(s)) ok += 2;
      if (ipv4.test(s)) ok += 4;
      const m = isoDate.exec(s);
      if (m !== null) ok += 8 + (m[4] !== undefined ? 16 : 0);
    }
  }
  console.log(ok);
}
main();
