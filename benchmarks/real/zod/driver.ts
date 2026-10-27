// garnet real-project benchmark: zod (benchmarks/real/run.sh zod). A schema of a user record with nested objects,
// arrays, an enum, a union, a record and string checks parses a fixed set of records many times, and safeParse
// rejects malformed ones; the checksum adds the parsed ids and counts the issues, so the native and the Node runs
// must agree.
import * as z from "./packages/zod/src/index.js";
import { performance } from "node:perf_hooks";

const User = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(64),
  email: z.string().email(),
  role: z.enum(["admin", "user", "guest"]),
  tags: z.array(z.string().min(1)).max(8),
  score: z.number().min(0).max(100),
  profile: z.object({
    age: z.number().int().min(0).max(150).optional(),
    bio: z.string().max(200).nullable(),
    website: z.string().url().optional(),
  }),
  settings: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
  addresses: z.array(z.object({ street: z.string(), city: z.string(), zip: z.string().regex(/^\d{5}$/) })).min(1),
});
const roles = ["admin", "user", "guest"];
function makeUser(i: number): Record<string, unknown> {
  const tags = ["a", "b" + (i % 7), "c"].slice(0, 1 + (i % 3));
  const profile: Record<string, unknown> = { age: (i * 13) % 90 + 10, bio: i % 2 === 0 ? "hello " + i : null };
  if (i % 5 === 0) profile.website = "https://example.com/" + i;
  return {
    id: i + 1, name: "user" + i, email: `user${i}@example.com`, role: roles[i % 3],
    tags, score: (i * 37) % 101, profile,
    settings: { dark: i % 2 === 0, size: (i % 5) * 10, theme: "t" + (i % 4) },
    addresses: [{ street: `${i} Main St`, city: "Springfield", zip: String(10000 + (i % 89999)) }],
  };
}
function makeBad(i: number): Record<string, unknown> {
  const u = makeUser(i);
  switch (i % 5) {
    case 0: u.email = "not-an-email"; break;
    case 1: u.id = -1; break;
    case 2: (u.addresses as Record<string, unknown>[])[0].zip = "abc"; break;
    case 3: u.role = "root"; break;
    default: u.tags = "x";
  }
  return u;
}
function main(): void {
  const users: unknown[] = [], bad: unknown[] = [];
  for (let i = 0; i < 1000; i++) { users.push(makeUser(i)); bad.push(makeBad(i)); }
  const t0 = performance.now();
  let ids = 0, names = 0, issues = 0;
  for (let rep = 0; rep < 100; rep++) {
    for (let i = 0; i < users.length; i++) { const u = User.parse(users[i]); ids += u.id; names += u.name.length; }
  }
  for (let rep = 0; rep < 20; rep++) {
    for (let i = 0; i < bad.length; i++) { const r = User.safeParse(bad[i]); if (!r.success) issues += r.error.issues.length; }
  }
  const ms = performance.now() - t0;
  process.stderr.write(`zod: ${ms.toFixed(1)} ms (${(120000 / ms * 1000).toFixed(0)} parses/s)\n`);
  console.log(`zod: ids ${ids} names ${names} issues ${issues}`);
}
main();
