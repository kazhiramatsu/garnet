class A{a(){return 1;}}class B extends A{b(){return 2;}}class C extends B{c(){return 3;}}
function main(){const o=new C();console.log(o.a()+o.b()+o.c());} main();
