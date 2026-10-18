export class Box { value = 4; }
export function allocate(constructors: (new () => Box)[]): Box { return new constructors[0](); }
