function mark(value: Function, context: ClassDecoratorContext): void {
  console.log(value.name, context.kind);
}

@mark
class Decorated {}

console.log(new Decorated());
