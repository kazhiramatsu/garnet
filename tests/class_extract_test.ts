import * as ts from "typescript";
import { ClassExtractor } from "./class_extract";

const file = process.argv[2] ?? "classfix.ts";
const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2020, strict: false, noEmit: true });
const sf = program.getSourceFile(file)!;
const ex = new ClassExtractor(program);
const { classes } = ex.extract(sf);

let fail = 0;
const byName: Record<string, any> = {};
for (const c of classes) byName[c.name] = c;
function ck(label: string, got: any, want: any) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`[${label}] ${JSON.stringify(got)} (want ${JSON.stringify(want)}) ${ok ? "PASS" : "*** FAIL ***"}`);
}

// structure
ck("Shape.fields", byName["Shape"].ownFields, ["id"]);
ck("Shape.methods", byName["Shape"].ownMethods.map((m: any) => `${m.name}:${m.kind}`), ["area:method", "describe:method"]);
ck("Circle.parent", byName["Circle"].parentName, "Shape");
ck("Circle.fields", byName["Circle"].ownFields, ["radius"]);
ck("Circle.methods", byName["Circle"].ownMethods.map((m: any) => `${m.name}:${m.kind}`), ["area:method", "scale:method", "diameter:getter"]);
ck("Square.parent", byName["Square"].parentName, "Shape");

// instantiation (RTA)
ck("Circle.instantiated", byName["Circle"].instantiated, true);
ck("Square.instantiated", byName["Square"].instantiated, true);
ck("Shape.instantiated(no direct new)", byName["Shape"].instantiated, false);

// stability
ck("Shape.stable", byName["Shape"].stable, true);
ck("Circle.stable", byName["Circle"].stable, true);
ck("Square.stable", byName["Square"].stable, true);
ck("Patched.stable(prototype mutate)", byName["Patched"].stable, false);
ck("Reassigned.stable(method reassign)", byName["Reassigned"].stable, false);
ck("Grown.stable(dynamic prop)", byName["Grown"].stable, false);
ck("Reproto.stable(setPrototypeOf)", byName["Reproto"].stable, false);

// diagnostics present
ck("Patched.reason", byName["Patched"].reasons.includes("prototype-mutation"), true);
ck("Reproto.reason", byName["Reproto"].reasons.includes("Object.setPrototypeOf"), true);

console.log(`\n${fail === 0 ? "ALL CLASS-EXTRACT TESTS PASS" : fail + " FAILURES"}`);
process.exit(fail === 0 ? 0 : 1);
