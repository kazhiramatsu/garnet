class Box{constructor(v){this.value=v;}get(){return this.value;}}
function kernel(N){let sum=0,i=0;while(i<N){const b=new Box(i%100);sum=(sum+b.get())%1000007;i=i+1;}return sum;}
function main(){console.log(kernel(50000000));} main();
