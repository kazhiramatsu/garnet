// An ordinary enum's members imported by name and through a namespace import fold to their
// constants; the enum objects themselves still cross the module boundary.
import { Flags, Kind, classify } from "./e";
import * as E from "./e";
console.log(Flags.SKIP, Flags.N, E.Flags.N + 1, Flags["RAW"], E.Kind.C, Kind.B);
console.log(classify("__v_skip"), classify(E.Flags.RAW), classify("x"));
console.log(Object.keys(Flags).join(","), Kind[6], E.Kind[0], E.Flags === Flags);
switch (Kind.C) { case E.Kind.C: console.log("c"); break; default: console.log("?"); }
