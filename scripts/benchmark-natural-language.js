'use strict';
// Opt-in benchmark. Never invokes the network when imported by offline tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const legacy = require('./evaluate-natural-language');
const DEFAULT_QUESTIONS = path.join(__dirname, '../test/fixtures/natural-language-benchmark.train.json');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const selector = /^(?:제\s*[1-9]\d*\s*조(?:\s*의\s*[1-9]\d*)?|별표\s*[1-9]\d*)$/;
// Optional per-question tool arguments ({"keywords":"분실, 변상"}), merged into the call next to the question.
const isArgs = value => value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
function validateQuestions(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('EMPTY_QUESTIONS');
  const ids = new Set();
  for (const row of rows) {
    if (Array.isArray(row)) { legacy.validateQuestions([row]); continue; }
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.q !== 'string' || !row.q.trim()
      || !Array.isArray(row.gt) || !row.gt.length || row.gt.some(g => !Number.isSafeInteger(g.lawId) || g.lawId < 1 || !Array.isArray(g.articles) || !g.articles.length || g.articles.some(a => typeof a !== 'string' || !selector.test(a))) || !isArgs(row.args)) throw new Error('INVALID_QUESTION');
    ids.add(row.id);
  }
  return rows;
}
function headingPattern(article) {
  const compact = article.replace(/\s/g, '');
  const m = /^제(\d+)조(?:의(\d+))?$/.exec(compact);
  if (m) return new RegExp(`^\\s*(?:#{1,6}[ \\t]*)?제[ \\t]*${m[1]}[ \\t]*조${m[2] ? '[ \\t]*의[ \\t]*'+m[2] : ''}[ \\t]*[(（]`, 'm');
  const n = /^별표(\d+)$/.exec(compact)?.[1];
  if (!n) throw new Error('INVALID_ARTICLE_SELECTOR');
  return new RegExp(`^\\s*(?:#{1,6}[ \\t]*)?(?:[\\[〔【〈<（(][ \\t]*)?별[ \\t]*표[ \\t]*${n}(?!\\d)(?:[ \\t]*[\\]〕】〉>）)])?(?=[ \\t]|$)`, 'm');
}
function bodyText(rule) {
  const parts = [typeof rule.excerpt === 'string' ? rule.excerpt : rule.excerpt?.text,
    typeof rule.content === 'string' ? rule.content : rule.content?.text, rule.markdown];
  if (Array.isArray(rule.articles)) for (const a of rule.articles) parts.push(a?.text, a?.content);
  return parts.filter(v => typeof v === 'string' && v.trim()).join('\n');
}
function scoreResponse(question, response, index = 0) {
  const sc = response?.structuredContent;
  const rules = Array.isArray(sc?.data?.rules) ? sc.data.rules : [];
  let error = sc?.ok === true && Array.isArray(sc?.data?.rules) ? null : /^[A-Z_]{1,80}$/.test(sc?.error?.code || '') ? sc.error.code : 'INVALID_RESPONSE';
  const choiceOnly = !rules.some(r => bodyText(r).trim()) && (error === 'AMBIGUOUS_RULE' || /규정.{0,80}(?:골라|선택)/s.test((response?.content || []).map(x=>x.text || '').join('\n')));
  let score;
  if (Array.isArray(question)) {
    const old = legacy.scoreResponse(question, response);
    error = old.error;
    score = { id: `legacy-${index+1}`, category: null, query: question[0], gt: null, scored: old.scored, top1: old.top1, top3: old.top3, bodyIncluded: old.excerptMatch, matched: [] };
  } else {
    const match = r => question.gt.some(g => String(g.lawId) === String(r.lawId));
    const matched = sc?.ok === true ? rules.flatMap((r, rank) => question.gt.filter(g => String(g.lawId) === String(r.lawId)).flatMap(g => g.articles.filter(a => headingPattern(a).test(bodyText(r))).map(article => ({ lawId: g.lawId, article, rank: rank+1 })))) : [];
    score = { id: question.id, category: question.cat || null, query: question.q, gt: question.gt, scored: true,
      top1: !error && !!rules[0] && match(rules[0]), top3: !error && rules.slice(0,3).some(match), bodyIncluded: matched.length > 0, matched };
  }
  return { ...score, error, choiceOnly, search: sc?.data?.search || null,
    rules: rules.map(r => ({lawId:r.lawId,title:r.title,historyId:r.historyId,evidenceStatus:r.evidenceStatus,text:bodyText(r)})) };
}
function statistics(results) {
  const scored = results.filter(r=>r.scored), body = scored.filter(r=>r.bodyIncluded !== null);
  const elapsed = results.map(r=>r.elapsedMs).sort((a,b)=>a-b), n=elapsed.length;
  const errors = {};
  for (const r of results) if (r.error) errors[r.error]=(errors[r.error]||0)+1;
  const metric = (rows,key) => ({ hits:rows.filter(r=>r[key]).length,total:rows.length,rate:rows.length?rows.filter(r=>r[key]).length/rows.length:null });
  const hasEnforcementHeading = rule => /^\s*(?:#{1,6}[ \t]*)?(?:\*\*)?제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?[ \t]*[(（]시행일[)）]/m.test(rule.text || '');
  const rules = results.flatMap(row => row.rules || []);
  const excerptQuality = {
    enforcementHeadingRules: rules.filter(hasEnforcementHeading).length,
    enforcementHeadingQuestions: results.filter(row => (row.rules || []).some(hasEnforcementHeading)).length,
    shortExpectedRules: results.reduce((n,row) => n + (row.rules || []).filter(rule => row.gt?.some(g => String(g.lawId) === String(rule.lawId)) && (rule.text || '').length < 500).length, 0),
    meanRules: results.length ? rules.length / results.length : null,
    meanCharacters: results.length ? rules.reduce((n,rule) => n + (rule.text || '').length, 0) / results.length : null,
  };
  return { excerptQuality, total:results.length, scored:scored.length, bodyIncluded:metric(body,'bodyIncluded'),top3:metric(scored,'top3'),top1:metric(scored,'top1'),
    medianMs:n?(elapsed[Math.floor((n-1)/2)]+elapsed[Math.ceil((n-1)/2)])/2:null,p95Ms:n?elapsed[Math.ceil(n*0.95)-1]:null,
    errors,choiceOnly:results.filter(r=>r.choiceOnly).length };
}
// The arguments sent for one question: the question itself as query, then the question's own args,
// then args from a separate file keyed by question id. With useArgs false only the query is sent.
function callArguments(question, { useArgs = true, argsById = null } = {}) {
  if (Array.isArray(question)) return { query: question[0] };
  const extra = useArgs ? { ...(question.args || {}), ...(argsById?.[question.id] || {}) } : {};
  return { query: question.q, ...extra };
}
async function evaluate(questions, call, onResult = () => {}, now = () => performance.now(), options = {}) {
  validateQuestions(questions);const results=[];
  for (let i=0;i<questions.length;i++) {
    const q=questions[i],args=callArguments(q,options),start=now();let response;
    try { response=await call(args.query,args); } catch { response={structuredContent:{ok:false,error:{code:'CALL_FAILED'}}}; }
    const {query:_query,...extra}=args;
    const r={...scoreResponse(q,response,i),...(Object.keys(extra).length?{args:extra}:{}),elapsedMs:Math.max(0,now()-start)};results.push(r);onResult(r,i+1);
  }
  return {summary:{...statistics(results),withArgs:results.filter(r=>r.args).length},results};
}
function formatMarkdown(report) {
  const s=report.summary, metric=m=>`${m.hits}/${m.total} (${m.rate===null?'—':(m.rate*100).toFixed(1)+'%'})`;
  const cell=v=>String(v??'—').replace(/[|\n\r]/g,' ');
  return ['# 자연어 조회 벤치마크','',`측정: ${report.startedAt || 'offline'}`,`기준 커밋: ${report.gitHead || '—'}`,`호출 인수: ${report.argsMode || 'query만'} (query 외 인수를 보낸 문항 ${s.withArgs ?? 0}/${s.total})`,`문항 SHA-256: ${report.questionsSha256 || '—'}`,`색인 SHA-256: ${report.indexSha256 || '—'}`,'',
    '| 지표 | 결과 |','|---|---|',`| 정답 조문 본문 포함 | ${metric(s.bodyIncluded)} |`,`| top3 | ${metric(s.top3)} |`,`| 1순위 | ${metric(s.top1)} |`,`| 중간값 / p95 | ${s.medianMs?.toFixed(1)} / ${s.p95Ms?.toFixed(1)} ms |`,`| 오류 코드 | ${JSON.stringify(s.errors)} |`,`| 본문 없이 규정 선택 요청 | ${s.choiceOnly} |`,`| 시행일 조문 표제가 든 반환 규정 / 문항 | ${s.excerptQuality?.enforcementHeadingRules} / ${s.excerptQuality?.enforcementHeadingQuestions} |`,`| 정답 규정 중 발췌 500자 미만 | ${s.excerptQuality?.shortExpectedRules} |`,`| 평균 반환 규정 수 / 본문 글자 수 | ${s.excerptQuality?.meanRules?.toFixed(2)} / ${s.excerptQuality?.meanCharacters?.toFixed(2)} |`,'',
    '법적 정확성·적용 여부를 판정하지 않습니다. 동일 lawId의 실제 본문에 조문/별표 표제가 있는지 확인합니다. top3는 반환 규정만 세고 후보 목록은 제외합니다. 기존 배열 문항은 기존 제목·키워드 방식으로 별도 채점합니다. p95는 nearest-rank입니다.','',
    '| ID | 본문 | top3 | 1순위 | ms | 오류 | 반환 규정 |','|---|---|---|---|---:|---|---|',
    ...report.results.map(r=>`| ${[r.id,r.bodyIncluded,r.top3,r.top1,r.elapsedMs.toFixed(1),r.error,r.rules.map(x=>`${x.lawId}:${x.title}`).join('; ')].map(cell).join(' | ')} |`),''].join('\n');
}
function parseArgs(args) {
  const o={questions:DEFAULT_QUESTIONS,output:null,timeout:60000,args:null,queryOnly:false};
  for(let i=0;i<args.length;i++) {if(args[i]==='--help')return {help:true};if(args[i]==='--query-only'){o.queryOnly=true;continue;}if(!['--questions','--output','--timeout','--args'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('INVALID_OPTIONS');o[args[i].slice(2)]=args[++i];}
  if(o.queryOnly&&o.args)throw new Error('INVALID_OPTIONS');
  o.timeout=Number(o.timeout);if(!o.output||!Number.isSafeInteger(o.timeout)||o.timeout<1)throw new Error('OUTPUT_AND_POSITIVE_TIMEOUT_REQUIRED');return o;
}
async function main(args=process.argv.slice(2)) {
  const o=parseArgs(args);if(o.help){console.log('npm run benchmark:natural-language -- --questions FILE --output NEW.json [--timeout MS] [--args ARGS.json | --query-only]\nEach question may carry an "args" object (for example {"keywords":"분실, 변상"}) that is merged into the lookup_dongguk_rule call next to the question. --args ARGS.json supplies them from a separate file keyed by question id; --query-only ignores them, so one question file can be measured both ways.\nWrites NEW.json + NEW.md without overwrite. Requires local --build-index. Uses a fresh MCP process and normal caches. Exit 0 means measurement completed, not accuracy target achieved.');return;}
  const input=fs.readFileSync(o.questions);const questions=validateQuestions(JSON.parse(input));
  const argsInput=o.args?fs.readFileSync(o.args):null;const argsById=argsInput?JSON.parse(argsInput):null;
  if(argsById&&(typeof argsById!=='object'||Array.isArray(argsById)||Object.values(argsById).some(value=>value===undefined||!isArgs(value))))throw new Error('INVALID_ARGS_FILE');
  const output=path.resolve(o.output),markdown=output.replace(/\.json$/i,'')+'.md';if(output===markdown||[output,markdown].some(f=>fs.existsSync(f)))throw new Error('OUTPUT_EXISTS');
  const created=[];try{for(const f of [output,markdown]){const fd=fs.openSync(f,'wx',0o600);fs.closeSync(fd);created.push(f);}}catch(e){for(const f of created)fs.unlinkSync(f);throw e;}
  const cacheRoot=process.env.XDG_CACHE_HOME || path.join(require('node:os').homedir(),'.cache');
  const indexPath=path.join(cacheRoot,'dongguk-rule-mcp/v2/public/corpus/corpus-v1.json');
  const before=sha(fs.readFileSync(indexPath));
  const client=new Client({name:'natural-language-benchmark',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'../src/index.js')],env:{...process.env,DONGGUK_MCP_PROFILE:'rules',DONGGUK_RULE_COOKIE:'',DONGGUK_MCP_NO_CACHE:'0',DONGGUK_LEGAL_MCP_ENABLED:'0',DONGGUK_FINANCE_PACK_PATH:''},stderr:'pipe'});
  try {
    await client.connect(transport);transport.stderr?.resume();
    const info=await client.callTool({name:'get_service_info',arguments:{}});const index=info.structuredContent?.data?.fullTextIndex;
    if(!index?.available)throw new Error('INDEX_UNAVAILABLE');
    const startedAt=new Date().toISOString();
    const evaluation=await evaluate(questions,(q,args)=>client.callTool({name:'lookup_dongguk_rule',arguments:args},undefined,{timeout:o.timeout}), (r,n)=>console.error(`${n}/${questions.length} ${r.id}: ${r.error || (r.bodyIncluded?'HIT':'MISS')}`),undefined,{useArgs:!o.queryOnly,argsById});
    const after=sha(fs.readFileSync(indexPath));if(after!==before)throw new Error('INDEX_CHANGED_DURING_BENCHMARK');
    const root=path.join(__dirname,'..');const sourceHashes=Object.fromEntries(fs.readdirSync(path.join(root,'src')).filter(f=>f.endsWith('.js')).sort().map(f=>[f,sha(fs.readFileSync(path.join(root,'src',f)))]));
    const report={startedAt,completedAt:new Date().toISOString(),gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes,serverVersion:client.getServerVersion()?.version,questionsFile:path.resolve(o.questions),questionsSha256:sha(input),argsMode:o.queryOnly?'query만(--query-only)':argsById?'query+문항별 인수(--args)':'query+문항에 든 args',...(argsInput?{argsFile:path.resolve(o.args),argsSha256:sha(argsInput)}:{}),indexPath,indexSha256:before,index,cache:'normal public disk cache; fresh MCP process; document responses may be cached',...evaluation};
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');fs.writeFileSync(markdown,formatMarkdown(report));console.log(JSON.stringify({output,markdown,...report.summary}));
  }finally{await client.close();await transport.close();}
}
if(require.main===module)main().catch(()=>{console.error('Benchmark failed: check options, new output paths and local index; no existing report was overwritten.');process.exitCode=1;});
module.exports={validateQuestions,callArguments,headingPattern,bodyText,scoreResponse,statistics,evaluate,formatMarkdown,parseArgs,main};
