'use strict';
// Synthetic upstream responses only; no live legal source or private pack.
const LAW='사학기관 재무ㆍ회계 규칙에 대한 특례규칙';
const NOW=new Date('2026-11-27T03:00:00Z');
const table='<table><tr><th colspan="6">계정과목</th></tr><tr><th>관</th><th>항</th><th>목</th><th>법인</th><th>학교</th><th>해설</th></tr><tr><td></td><td></td><td>4223</td><td></td><td></td><td></td></tr><tr><td></td><td></td><td>소모품비</td><td>×</td><td>○</td><td>합성 설명: 복사용지 및 프린트용지</td></tr></table>';
const text=t=>({content:[{type:'text',text:t}]});
function createClient({proof='valid'}={}){
 const calls=[];
 return {calls,async listTools(){return {tools:[{name:'legal_analysis'},{name:'get_annexes',inputSchema:{type:'object',properties:{date:{type:'string'}}}}]};},async callTool({name,arguments:a}){
  calls.push({name,arguments:a});
  if(name==='search_law')return text(`1. ${LAW} [현행]\n   - 법령ID: 007333\n   - MST: 251375\n   - 공포일: 20200101 / 시행일: 20200101\n`);
  if(name==='legal_analysis')return text(`행위시법 판단: ${LAW} @ ${a.date}\n▶ 기준일에 시행 중이던 버전\n ${LAW} [시행 2020.01.01] [제1호, 2020.01.01] (MST 251375)`);
  if(name==='get_law_text')return text(`법령명: ${LAW}\n시행일: 20200101\n${a.jo}(합성 제목)\n① 합성 검증 본문이다.`);
  if(name==='get_annexes'){
   const prefix=a.date&&proof!=='missing'?`📅 기준일 ${a.date} 당시 시행 버전의 별표입니다.\n 「${LAW}」 [시행 2020.01.01] [제1호] (MST ${proof==='mismatch'?'999999':'251375'})\n\n`:'';
   return text(prefix+`${LAW} - 자금계산서 계정과목 명세표\n(파일 형식: HWP)\n\n[별표 1]\n${table}`);
  }
  throw Error('unexpected synthetic tool');
 }};
}
module.exports={LAW,NOW,createClient};
