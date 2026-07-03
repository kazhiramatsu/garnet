function f(x){try{if(x<0)throw "neg";return "ok";}catch(e){return "caught";}finally{console.log("always");}}
function main(){console.log(f(5));console.log(f(-1));}
main();
