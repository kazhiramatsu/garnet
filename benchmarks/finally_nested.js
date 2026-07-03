function f(){try{try{return "inner";}finally{console.log("inner-finally");}}finally{console.log("outer-finally");}}
function main(){console.log(f());}
main();
