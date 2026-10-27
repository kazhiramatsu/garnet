// A type-only import is erased: it must not order the modules. The first import here reaches
// ast.ts through type-only edges, and ast.ts's own type-only edge leads (through a value import)
// to parser.ts, which reads ast.ts's enum at its top level: ordered over every edge, parser.ts
// would run before ast.ts (vue's compiler-core); over the runtime edges ast.ts runs first.
import type { Options } from "./options";
import { defaults, describe } from "./parser";
const o: Options = defaults;
console.log(o.kind, o.name, describe());
