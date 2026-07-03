class Base{constructor(v){this.value=v;}get(){return this.value;}}
class IntBox extends Base{constructor(v){super(v);}}
function kernel(N){let sum=0,i=0;while(i<N){const b=new IntBox(i%100);sum=(sum+b.get())%1000007;i=i+1;}return sum;}
function main(){console.log(kernel(20000000));} main();
