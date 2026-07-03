class A{m(){return 1;}}class B{m(){return 2;}}
function main(){const a=new A();const b=Object.getPrototypeOf(a);Object.setPrototypeOf(a,B.prototype);const af=Object.getPrototypeOf(a);console.log(b===af?0:1);console.log(a.m());} main();
