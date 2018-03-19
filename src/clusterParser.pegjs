start
  = cluster

cluster
  = left:processGroup "," right:cluster { return left.concat(right); }
  / solo:processGroup { return [solo]; }

processGroup
  = left:integer ":" right:process { return { count: left, process: right }; }
  / solo:process { return { count: 1, process: solo } }

process
  = "[" solo:resourceList "]" { return solo }

resourceList
  = left:resourceGroup "," right:resourceList { return left.concat(right); }
  / solo:resourceGroup { return [solo]; }

resourceGroup
  = left:integer ":" right:resource { return { count: left, name: right }; }
  / solo:resource { return { count: 1, name: solo } }

resource
  = chars:[a-zA-Z]+ alpha:[a-zA-Z0-9]* { return chars.join("") + alpha.join(""); }

integer
  = digits:[0-9]+ { return parseInt(digits.join(""), 10); }
