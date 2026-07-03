class Box{constructor(v){this.v=v;}get(){return this.v;}}
function make(n){const b=new Box(n);return b;}
function main(){const b=make(42);console.log(b.get());const local=new Box(7);console.log(local.get());}
main();
