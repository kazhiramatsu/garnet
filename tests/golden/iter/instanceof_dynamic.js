class Animal {
    constructor(n) { this.name = n; }
}
class Dog extends Animal {
    bark() { return "woof"; }
}
class Cat extends Animal {
    meow() { return "meow"; }
}
function check(a) {
    // `a` is statically Animal but may be a Dog/Cat at runtime -> dynamic instanceof
    console.log(a instanceof Dog);
    console.log(a instanceof Cat);
    console.log(a instanceof Animal);
}
function main() {
    const d = new Dog("Rex");
    const c = new Cat("Tom");
    check(d); // true, false, true
    console.log("---");
    check(c); // false, true, true
    // any-typed
    const x = new Dog("Fido");
    console.log(x instanceof Dog); // true
    console.log(x instanceof Animal); // true
    console.log(x instanceof Cat); // false
}
main();
