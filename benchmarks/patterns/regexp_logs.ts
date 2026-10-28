// Log lines parsed with named groups (`exec` and `groups`), a global replace with a function
// replacer, and a split over whitespace (docs/regexp_vm_design.md, the R2 kernels).
const line = /^(?<ip>\S+) \S+ \S+ \[(?<time>[^\]]+)\] "(?<method>[A-Z]+) (?<path>\S+) (?<proto>[^"]+)" (?<status>\d{3}) (?<size>\d+|-)/;
const digits = /\d+/g;
const spaces = /\s+/;
const lines = [
  '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326',
  '10.1.2.3 - - [11/Oct/2000:14:01:02 +0900] "POST /api/v1/items?x=1 HTTP/1.1" 201 -',
  '192.168.100.200 - alice [12/Oct/2000:09:00:00 +0000] "DELETE /things/42 HTTP/2" 404 118',
  'bad line without the shape',
  '::1 - - [01/Jan/2024:00:00:00 +0000] "GET / HTTP/1.1" 304 0',
];
function main(): void {
  let sum = 0;
  let parts = 0;
  for (let round = 0; round < 20000; round++) {
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i];
      const m = line.exec(s);
      if (m !== null && m.groups !== undefined) {
        sum = (sum + m.groups.status.length * 3 + m.groups.path.length + (m.groups.size === "-" ? 1 : m.groups.size.length)) | 0;
      }
      const bumped = s.replace(digits, (d) => String(d.length + round % 7));
      sum = (sum + bumped.length) | 0;
      parts += s.split(spaces).length;
    }
  }
  console.log(sum, parts);
}
main();
