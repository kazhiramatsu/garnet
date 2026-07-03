class Container{constructor(x){this.item=x;}load(){return this.item;}}
class NumCell extends Container{constructor(n){super(n);}twice(){return this.load()+this.load();}}
class StrCell extends Container{constructor(s){super(s);}shout(){return this.load();}}
function main(){const n=new NumCell(10);console.log(n.twice());const s=new StrCell("hi");console.log(s.shout());console.log(n.load());} main();
