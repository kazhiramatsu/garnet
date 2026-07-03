class P{constructor(x){this.x=x;}}
function readVia(p){return p.x;}
function main(){const p=new P(777);console.log(readVia(p));} main();
