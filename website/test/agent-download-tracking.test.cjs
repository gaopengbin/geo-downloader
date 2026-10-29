const {test}=require('node:test');const assert=require('node:assert/strict');const ts=require('typescript');const vm=require('node:vm');const fs=require('node:fs');
test('all Agent download handlers preserve cancellation and distinguish mirrors',()=>{
 const calls=[];const module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('src/app/agent/AgentDownloadLink.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='react/jsx-runtime'?{jsx:(type,props)=>({props})}:name.includes('CTALink')?{default:()=>{}}:name.includes('agent-release')?{AGENT_PUBLIC_VERSION:'0.2.9'}:{trackProductEvent:(...args)=>calls.push(args)}});
 const Link=module.exports.default;
 for(const [href,channel] of [['https://download.laogao.xyz/a.exe','mirror'],['https://github.com/a.exe','github']]){
  const node=Link({href});node.props.onClick({defaultPrevented:false});assert.equal(calls.at(-1)[1].channel,channel);assert.equal(calls.at(-1)[1].campaign,'geod-agent-download');
 }
 Link({href:'https://github.com/a.exe',onClick:e=>{e.defaultPrevented=true}}).props.onClick({defaultPrevented:false});assert.equal(calls.length,2);
 const page=fs.readFileSync('src/app/agent/PageContent.tsx','utf8');assert(!/<(?:a|CTALink)[^>]+href=\{AGENT_(?:GITHUB_)?DOWNLOAD_URL/.test(page));
});
