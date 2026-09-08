'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dongguk-cop-service-'));
process.env.XDG_CACHE_HOME=root;process.env.DONGGUK_MCP_NO_CACHE='0';process.env.DONGGUK_MCP_PROFILE='rules';
process.env.DONGGUK_RULE_COOKIE='synthetic-private-cookie';process.env.DONGGUK_FINANCE_PACK_PATH=path.join(root,'must-not-be-read.json');
const aliasPath=path.join(root,'aliases.json');
fs.writeFileSync(aliasPath,JSON.stringify({'직군통합':['교원복무규정','직원복무규정']}));
process.env.DONGGUK_RULE_ALIASES=aliasPath;
let network=0;const fetchPath=require.resolve('node-fetch');require(fetchPath);require.cache[fetchPath].exports=async()=>{network++;throw Error('Offline only');};
const {createServer}=require('../src/index.js');
const {compareAppendices}=require('../src/appendices.js');
const {printConfig}=require('../src/cli.js');
const {issue}=require('../scripts/issue-token.js');
const version=require('../package.json').version;
const hash=(...p)=>crypto.createHash('md5').update(p.join('|')).digest('hex');
const privateScope='private-'+crypto.createHash('sha256').update(process.env.DONGGUK_RULE_COOKIE).digest('hex').slice(0,12);
function seed(scope,cat,key,value){const dir=path.join(root,'dongguk-rule-mcp','v2',scope,cat);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,key+'.json'),JSON.stringify(value));}
const hit={lawId:1,historyId:10,title:'여비규정',revisedAt:'2024.01.01'};
for(const scope of ['public',privateScope]){
  seed(scope,'history','1',[{historyId:20,revisedAt:'2026.09.01'},{historyId:10,revisedAt:'2024.01.01'}]);
  seed(scope,'search',hash('여비규정',false,1,10,'0'),{total:1,hits:[hit]});
  seed(scope,'search',hash('여비',false,1,10,'0'),{total:0,hits:[]});
  seed(scope,'content','1_10',{title:'여비규정',markdown:'### 제1조(숙박비)\n과거 숙박비'});
  seed(scope,'content','1_20',{title:'여비규정',markdown:'### 제1조(숙박비)\n'+(scope==='public'?'공개 숙박비':'내부 쿠키 숙박비')});
  seed(scope,'original','1_10',{markdown:'제1조(숙박비)\n과거\n\n< 별 표 1 > 국내 여비\n\n| 항목 | 금액 |\n| 숙박비 | 100,000원 |'});
  seed(scope,'original','1_20',{markdown:'제1조(숙박비)\n현재\n\n< 별 표 1 > 국내 여비\n\n| 항목 | 금액 |\n| 숙박비 | 120,000원 |'});
}
seed('public','search',hash('학칙',false,1,10,'0'),{total:2,hits:[{lawId:2,title:'학칙'},{lawId:3,title:'학칙'}]});
for(const query of ['전결규정','전결']) seed('public','search',hash(query,false,1,10,'0'),{total:1,hits:[{lawId:5,title:'위원회전결규정'}]});
seed('public','search',hash('위임전결규정',false,1,10,'0'),{total:1,hits:[{lawId:4,title:'위임전결규정'}]});
seed('public','search',hash('위임전결',false,1,10,'0'),{total:0,hits:[]});
for(const query of require('../src/lookup.js').searchVariants('직군통합'))seed('public','search',hash(query,false,1,10,'0'),{total:0,hits:[]});
seed('public','search',hash('교원복무규정',false,1,10,'0'),{total:1,hits:[{lawId:6,title:'교원복무규정'}]});
seed('public','search',hash('직원복무규정',false,1,10,'0'),{total:1,hits:[{lawId:7,title:'직원복무규정'}]});
seed('public','history','4',[{historyId:40,revisedAt:'2024.01.01'}]);
seed('public','content','4_40',{title:'위임전결규정',markdown:'### 제1조(목적)\n본 규정의 목적'});
seed('public','original','4_40',{markdown:'제1조(목적)\n본 규정의 목적'});
let count=0;function check(name,fn){fn();count++;console.log('PASS '+name);}
async function connect(profile){const s=createServer({profile}),c=new Client({name:'profile-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await s.connect(b);await c.connect(a);return{c,s,call:async(name,args={})=>(await c.callTool({name,arguments:args})).structuredContent};}
async function main(){
  const pub=await connect('rules'),priv=await connect('finance');
  try{
    const pubTools=(await pub.c.listTools()).tools,privTools=(await priv.c.listTools()).tools;
    check('10 public tools; finance hidden',()=>{assert.equal(pubTools.length,10);assert.ok(!pubTools.some(x=>x.name.startsWith('get_finance_')));});
    check('12 opt-in finance tools',()=>assert.equal(privTools.length,12));
    const denied=await pub.call('get_finance_context',{query:'출장'});
    check('hidden tools cannot be invoked by name',()=>assert.equal(denied.error.code,'TOOL_NOT_AVAILABLE'));
    const [publicContent,privateContent]=await Promise.all([pub.call('get_rule_content',{law_id:1}),priv.call('get_rule_content',{law_id:1})]);
    check('rules cache isolated from configured school cookie',()=>assert.match(publicContent.data.contentMarkdown,/공개 숙박비/));
    check('finance cookie cache retained',()=>assert.match(privateContent.data.contentMarkdown,/내부 쿠키 숙박비/));
    const info=await pub.call('get_service_info');
    check('public service metadata never implies private access',()=>{assert.equal(info.data.profile,'rules');assert.equal(info.data.privacy.authenticatedUpstream,false);});
    const wise=await pub.call('lookup_dongguk_rule',{rule_keyword:'여비규정',campus:'WISE'});
    check('WISE searches real unified category and discloses no campus filter',()=>{assert.equal(wise.ok,true);assert.equal(wise.data.campusScope.filterApplied,false);assert.equal(wise.data.query.campus,'wise');});
    const travel=await pub.call('lookup_dongguk_rule',{rule_keyword:'여비규정',terms:'서울캠퍼스 미국 출장 숙박비',campus:'seoul'});
    check('campus does not invent a domestic travel condition',()=>assert.equal(travel.data.query.effectiveTerms,'서울캠퍼스 미국 출장 숙박비'));
    const alias=await pub.call('lookup_dongguk_rule',{rule_keyword:'전결규정'});
    check('later exact alias wins over an earlier partial title',()=>assert.equal(alias.data.rules[0].lawId,4));
    const pastAlias=await pub.call('applicable_rule',{rule_keyword:'전결규정',date:'2025-01-01'});
    check('historical alias also waits for exact title',()=>assert.equal(pastAlias.data.lawId,4));
    const manyAlias=await pub.call('lookup_dongguk_rule',{rule_keyword:'직군통합'});
    check('all external alias targets are collected before choosing a rule',()=>{assert.equal(manyAlias.error.code,'AMBIGUOUS_RULE');assert.equal(manyAlias.error.details.candidates.length,2);});
    const manyPastAlias=await pub.call('applicable_rule',{rule_keyword:'직군통합',date:'2025-01-01'});
    check('historical lookup does not choose the first exact alias target',()=>assert.equal(manyPastAlias.error.code,'AMBIGUOUS_RULE'));
    const manyCitationAlias=await pub.call('verify_rule_citations',{text:'「직군통합」 제1조'});
    check('citation verification does not pass the first of multiple alias targets',()=>{assert.equal(manyCitationAlias.data.citations[0].status,'RULE_AMBIGUOUS');assert.equal(manyCitationAlias.data.summary.verified,0);});
    const ambiguous=await pub.call('lookup_dongguk_rule',{rule_keyword:'학칙'});
    check('duplicate title is not selected automatically',()=>{assert.equal(ambiguous.error.code,'AMBIGUOUS_RULE');assert.equal(ambiguous.error.details.candidates.length,2);});
    const direct=await pub.call('lookup_dongguk_rule',{law_id:1,terms:'숙박비'});
    check('selected LAW_ID supports HWP lookup',()=>{assert.equal(direct.data.rules[0].lawId,1);assert.equal(direct.data.rules[0].title,'여비규정');});
    const comparison=await pub.call('compare_rule_versions',{law_id:1,from_history_id:10});
    check('whole-rule comparison includes appendix changes',()=>{assert.equal(comparison.data.appendixComparison.status,'compared');assert.equal(comparison.data.appendixComparison.counts.changed,1);});
    for(const args of [{keyword:'x',offset:100000},{keyword:'x',limit:1.5},{keyword:'x',campus:'2'}]){
      const invalid=await pub.call('search_rule',args);check('invalid bound/campus rejected '+JSON.stringify(args),()=>assert.equal(invalid.error.code,'INVALID_ARGUMENT'));
    }
    const sensitive=await pub.call('search_rule',{keyword:'인증토큰=synthetic-only'});
    check('credentials in search text blocked before source requests',()=>assert.equal(sensitive.error.code,'SENSITIVE_INPUT'));
    check('all service checks offline',()=>assert.equal(network,0));
    check('duplicate appendix labels disclose ambiguity',()=>assert.equal(compareAppendices('<별표 1> A\n1\n<별표 1> B\n2','<별표 1> C\n3').status,'partial'));
    check('no extracted appendix does not mean unchanged',()=>assert.equal(compareAppendices('본문','본문').status,'not_identified'));
    check('appendix text formatting normalized',()=>assert.equal(compareAppendices('<별표 1> A\n x  y','<별표 1> A\n x y').counts.unchanged,1));
    check('client config uses installed absolute entry and public profile',()=>{const d=JSON.parse(printConfig('claude'));assert.ok(path.isAbsolute(d.mcpServers['dongguk-rule'].command));assert.equal(d.mcpServers['dongguk-rule'].args.at(-1),'rules');assert.match(printConfig('codex'),/mcp_servers.dongguk-rule/);});
    const doctor=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../src/index.js'),'--doctor','--json'],{encoding:'utf8'}));
    check('doctor exercises protocol offline',()=>{assert.equal(doctor.ok,true);assert.equal(doctor.version,version);assert.equal(doctor.upstreamChecked,false);});
    const registry=path.join(root,'secure','registry.json'),out=path.join(root,'secure','member.token');
    issue({id:'group-a',registry,out,expires:'2099-01-01T00:00:00Z'});
    const token=fs.readFileSync(out,'utf8').trim(),data=JSON.parse(fs.readFileSync(registry,'utf8'));
    check('issued secret never appears in token registry',()=>{assert.ok(!fs.readFileSync(registry,'utf8').includes(token));assert.equal(data.tokens[0].sha256,crypto.createHash('sha256').update(token).digest('hex'));assert.deepEqual(data.tokens[0].endpoints,['/mcp/rules']);});
    check('token output protected',()=>assert.equal(fs.statSync(out).mode&0o777,0o600));
    check('duplicate IDs rejected without altering issued token',()=>{assert.throws(()=>issue({id:'group-a',registry,out:path.join(root,'other.token'),expires:'2099-01-01T00:00:00Z'}));assert.equal(fs.readFileSync(out,'utf8').trim(),token);});
    check('nonexistent expiry rejected',()=>assert.throws(()=>issue({id:'group-b',registry,out:path.join(root,'other.token'),expires:'2099-02-30T00:00:00Z'})));
    check('missing token CLI argument fails',()=>assert.equal(spawnSync(process.execPath,[path.join(__dirname,'../scripts/issue-token.js'),'--id','group-b'],{cwd:root}).status,1));
  }finally{await pub.c.close();await priv.c.close();await pub.s.close();await priv.s.close();}
  console.log(`CoP service regression: ${count} passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
