const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict'),vm=require('node:vm');
const file=path.join(__dirname,'..','src','lib','account-return-to.ts');
const context={exports:{},URL,URLSearchParams};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const safe=context.exports.safeAccountDestination,origin='https://geod.laogao.xyz';
for(const destination of ['/dashboard','/admin/applications','/geod/workspace','/api/geod/oauth/authorize?client_id=test&state=return-test'])assert.equal(safe('?returnTo='+encodeURIComponent(destination),origin),destination);
for(const section of ['overview','products','profile','security']){const destination='/dashboard#'+section;assert.equal(safe('?returnTo='+encodeURIComponent(destination),origin),destination);}
for(const destination of ['//evil.test/','/\\evil.test/','https://evil.test/','/api/account/logout','/%2f%2fevil.test','/geod/../api/account/password'])assert.equal(safe('?returnTo='+encodeURIComponent(destination),origin),'/dashboard');
for(const destination of ['/geod/cli','/geod/cli/'])assert.equal(safe('?returnTo='+encodeURIComponent(destination),origin),'/browser');
console.log('16 account return checks passed (console sections, OAuth continuation, retired experience and redirect rejection)');
