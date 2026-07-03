class Pair{constructor(a,b){this.a=a;this.b=b;}first(){return this.a;}second(){return this.b;}}
class Box{constructor(v){this.value=v;}get(){return this.value;}}
function main(){const p=new Pair(3,4);console.log(p.first()+p.second());const n=new Box(new Box(99));console.log(n.get().get());const ps=new Pair("x",5);console.log(ps.second());} main();
