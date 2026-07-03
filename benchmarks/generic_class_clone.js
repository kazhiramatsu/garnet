class Box{constructor(v){this.value=v;}get(){return this.value;}}
function main(){const bn=new Box(42);const bs=new Box("hi");console.log(bn.get());console.log(bs.get());} main();
