#!/usr/bin/env node
'use strict';
// Tokens are written to a protected file, never to stdout or the registry.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readTokenFile}=require('../src/http-server.js');
const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i>=0&&!String(args[i+1]||'').startsWith('--')?args[i+1]:undefined;};
function issue({id,registry,out,expires}) {
  if(!/^[A-Za-z0-9_.-]{1,64}$/.test(id||'')||!registry||!out||!expires) throw new Error('--id, --registry, --out, --expires를 모두 지정하세요.');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires)||!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=Date.now()||new Date(expires).toISOString().replace('.000','')!==expires)throw new Error('--expires는 실제 존재하는 미래의 UTC ISO 시각이어야 합니다.');
  registry=path.resolve(registry);out=path.resolve(out);
  if(registry===out)throw new Error('등록부와 토큰 출력 파일은 달라야 합니다.');
  const lock=registry+'.lock';let fd,outputCreated=false;
  fs.mkdirSync(path.dirname(registry),{recursive:true,mode:0o700});
  try {
    fd=fs.openSync(lock,'wx',0o600);
    const data=fs.existsSync(registry)?JSON.parse(fs.readFileSync(registry,'utf8')):{tokens:[]};
    if(!Array.isArray(data.tokens)||data.tokens.some(x=>x.id===id)||data.tokens.length>=16384)throw new Error('중복 id 또는 등록부 형식/개수 제한을 확인하세요.');
    const token=crypto.randomBytes(32).toString('base64url');
    data.tokens.push({id,sha256:crypto.createHash('sha256').update(token).digest('hex'),enabled:true,expiresAt:expires,endpoints:['/mcp/rules']});
    fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});
    fs.writeFileSync(out,token+'\n',{flag:'wx',mode:0o600});outputCreated=true;
    const temp=registry+'.'+process.pid+'.tmp';
    try{fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});readTokenFile(temp);fs.renameSync(temp,registry);}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    return {id,registry,out,expiresAt:expires,endpoints:['/mcp/rules'],next:'서버가 이 등록부를 읽도록 연결하고 재시작한 뒤 사용자에게 보호된 경로로 전달하세요.'};
  }catch(e){if(outputCreated)fs.unlinkSync(out);throw e;}
  finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
}
if(require.main===module){
  if(args.includes('--help'))console.log('npm run issue-token -- --id group-a --registry /secure/tokens.json --out /secure/group-a.token --expires 2027-01-01T00:00:00Z');
  else try{console.log(JSON.stringify(issue({id:arg('--id'),registry:arg('--registry'),out:arg('--out'),expires:arg('--expires')}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={issue};
