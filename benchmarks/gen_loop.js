function* range(n){for(let i=0;i<n;i++){yield i;}}
function main(){const g=range(4);console.log(g.next().value);console.log(g.next().value);console.log(g.next().value);console.log(g.next().value);console.log(g.next().done?1:0);}
main();
