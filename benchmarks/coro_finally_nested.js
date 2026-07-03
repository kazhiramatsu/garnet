async function l(s){console.log(s);}
async function f(){try{try{return "deep";}finally{await l("inner-fin");}}finally{await l("outer-fin");}}
async function main(){console.log(await f());}
main();
