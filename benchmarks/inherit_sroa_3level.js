class A{constructor(a){this.a=a;}base(){return this.a;}}
class B extends A{constructor(a,b){super(a);this.b=b;}}
class C extends B{constructor(a,b){super(a,b);}sum(){return this.a+this.b;}}
function kernel(N){let s=0,i=0;while(i<N){const c=new C(i%10,i%7);s=(s+c.sum())%1000007;i=i+1;}return s;}
function main(){console.log(kernel(10000000));} main();
