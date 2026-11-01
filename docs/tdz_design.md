# The temporal dead zone of captured bindings

Session 363. Exporter (`computeTdzBindings`, `tdzLoad`), emitter (`tdz.hole`, `tdz.check:`), runtime (`TS_TDZ_HOLE`).

## Why

A read of a `let`, `const` or `using` binding before its declaration has run is a ReferenceError. The exporter
checked this by position inside one function (`isLexicalTdzUse`): a closure was never checked, so

    function f() { return x + 1; }
    f();
    let x = 1;

gave `1` (a typed cell's zero), a captured value was whatever the capture copied, and a module constant was folded
to its value. A program with this bug throws under Node and silently continues here.

## The fact

Most bindings cannot be reached early, and a module's constants are the hottest reads there are: a test on every read
is not acceptable, and V8 only gets away with it because its optimizer removes them. So the exporter proves the
common case. One pass over a scope's statements, in order, keeps the set of names the code so far can reach:

- what a statement that runs mentions, identifier by identifier;
- through a name, the code the name holds: a function declaration of the scope (wherever it stands: it is
  hoisted), a class's methods and instance initializers, a `const` initialized with a function, a class without
  static members, or an object literal of those. Such code runs only if the name is mentioned;
- any other closure (an argument, an assignment, an array element) may run at once, so its body counts as mentioned.

A binding that is in the set when its declaration is reached is a *dead-zone binding*. Every other binding keeps
exactly what it had. A closure can only name a binding from inside the binding's scope, so one pass per scope
following that scope's names is enough: the work is close to linear.

The pass does not see across modules. A function of a module in an import cycle that another module calls during
evaluation reads the binding unchecked (the top-level reads of a cycle are `isCyclicCrossModuleTdzUse`'s).

A binding declared in one clause of a `switch` and named in another is a dead-zone binding too, captured or not:
the jump can pass over the declaration.

## Emission

A dead-zone binding lives in a plain cell, never a typed record field or a captured value (`recordEligible`,
`cellOnlySyms`). The cell starts as `TS_TDZ_HOLE`, in the function's prologue and in a loop body's cell of each
iteration. A read or a write that is not proven after the declaration (`tdzProvenAfter`: same function, later
position, not in a `switch`) loads the raw value into a `reference` local and tests it with `tdz.check:<name>`, before
the local's representation takes it. A module constant of this kind is not folded, and a namespace object's getter tests it.

`for (let x of expr)`: a mention in `expr` is an error wherever it stands, a closure in it included: that scope's
binding is never initialized.

`TSAOT_TDZ=0` turns the pass off.

## Left

A class binding keeps the `undefined` test of `binding.check`: `new K()` and `instanceof` throw the ReferenceError;
reading the value by other means gives undefined (a TypeError where it is used, not a ReferenceError).
