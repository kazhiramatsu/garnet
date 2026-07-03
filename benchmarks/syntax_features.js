function f(){let s=10;s+=5;s-=2;s*=2;s%=7;let t=s++;let u=++s;const neg=-s;const a=(s>0)&&(s<100);const b=(s>100)||42;const tern=s>5?100:200;let acc=t+u+neg;acc=acc+(a?1:0)+b+tern;return acc;}
function main(){console.log(f());} main();
