# import() of a bundled module

Session 363. `exporter/exporter.ts`, `runtime/ts_rt.c` (`ts_import_bundled`).

## Why

A dynamic import of a module the program bundles was a compile-time reject, because every module is hoisted into
`__module_init` and runs at startup, where `import()` asks for it later, or never. Code splitting, optional dependencies and a
loader behind a flag all stopped the compile. test262's `language/expressions/dynamic-import` has 900 cases.

## The design

Whole-program compilation keeps the module in the binary. Only when it runs changes.

- A **lazy module** is one only `import()` reaches: `computeModuleOrder` appends, after the static order, each target that is not
  live, with the static imports of its own that are not live either.
- The top-level statements of a lazy module become a function of their own, `__lazy_init_<n>`. What stays in `__module_init`, ahead
  of every module, has no effect to delay: function values and namespace objects (`import * as`).
- A lazy module's top-level bindings stay `__module_init`'s, as every module's are (`declaredIn`). Their cells exist from the start,
  and the lazy function reaches them as any function reaches a module's binding: it captures them (`freeVars`). The bindings of its
  nested blocks are its own. So nothing about ownership, cells, the module record or the analyses changes.
- A **record** in the runtime for each lazy module and each target of an `import()` (`emitImportRecords`, at the start of
  `__module_init`): the namespace object, the lazy function, the lazy modules it imports. A target's exports are cells
  (getters read them), so the namespace can be built before the module has run.

## At run time

`import("./m")` is `ts_import_bundled(record, options)`: the options are read now (a failure rejects), the promise is returned, and a
microtask evaluates the module, as Node loads a module after the code that asked has run. `import_evaluate` runs the lazy imports first,
then the function, once: a cycle sees a module that is running and goes on, a module that threw throws the same value at
every later import, a top-level await leaves a promise as the module's result. The import's promise then resolves with the
namespace, through the ordinary resolution, so a module exporting `then` is a thenable.

A specifier the program cannot know (`import(x)`) has its ToString run and rejects, naming the module; a literal that names no module of
the program rejects at run time as before. `const s = "./m"; import(s)` reaches a module the program has for another reason; one it
does not have stays a compile-time reject, as a compiled program cannot load it and the compiler can say so.

## Gaps

- The order against other work is not Node's: Node reads the file first, so its evaluation comes after later macrotasks.
- An early error in a lazy module is a compile-time error of the program, not a rejection.
- The string forms `import(cond ? "./a" : "./b")` are not followed: the modules are not in the program.
