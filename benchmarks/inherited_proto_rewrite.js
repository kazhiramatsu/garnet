class Base{greet(){return 1;}}
class Sub extends Base{}
function run(s){return s.greet();}
function main(){const s=new Sub();Base.prototype.greet=function(){return 99;};console.log(run(s));} main();
