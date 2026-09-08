'use strict';
const cheerio=require('cheerio');
function parseAccountAppendix(text) {
  if(typeof text!=='string'||text.length>500000||!/<table[\s>]/i.test(text)) return [];
  const $=cheerio.load(text),accounts=[];
  $('table').each((tableIndex,table)=>{
    if(!/계정과목|과목/.test($(table).text())) return;
    const grid=[];
    $(table).find('tr').slice(0,2000).each((r,tr)=>{
      grid[r] ||= [];let c=0;
      $(tr).children('td,th').each((_,cell)=>{
        while(grid[r][c]!==undefined&&c<40)c++;
        if(c>=40)return;
        const raw=$(cell).clone();raw.find('br').replaceWith(' ');
        const value=raw.text().replace(/\s+/g,' ').trim();
        const colspan=Math.min(40,Math.max(1,Number($(cell).attr('colspan'))||1));
        const rowspan=Math.min(256,Math.max(1,Number($(cell).attr('rowspan'))||1));
        for(let y=r;y<Math.min(2000,r+rowspan);y++) {grid[y] ||= [];for(let x=c;x<Math.min(40,c+colspan);x++)grid[y][x]=value;}
        c+=colspan;
      });
    });
    let columns=null;
    for(let r=0;r<grid.length;r++) {
      const row=grid[r];
      if(row.includes('관')&&row.includes('항')&&row.includes('목')) {
        const subject=row.indexOf('목'),corporation=row.findIndex(x=>/법인/.test(x)),school=row.findIndex(x=>/학교/.test(x)),description=row.findIndex(x=>x==='해설');
        columns=subject>=0&&corporation>subject&&school>corporation&&description>school?{subject,corporation,school,description}:null;
        continue;
      }
      if(!columns)continue;
      const code=row[columns.subject];
      if(!/^\d{4}$/.test(code||''))continue;
      const next=grid[r+1];
      if(!next||!/[가-힣]/.test(next[columns.subject]||'')||/^[\d\s]+$/.test(next[columns.subject]))continue;
      const name=next[columns.subject],corporation=next[columns.corporation]||row[columns.corporation],school=next[columns.school]||row[columns.school];
      if(!/^[○×]$/.test(corporation||'')||!/^[○×]$/.test(school||''))continue;
      const explanation=[row[columns.description],next[columns.description]].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' ');
      accounts.push({code,name,description:explanation,applicable_to:{school:school==='○',corporation_general:corporation==='○'},locator:{type:'annex_html_rows',table:tableIndex+1,start_row:r+1,end_row:r+2}});
    }
  });
  return accounts.filter((a,i,list)=>list.findIndex(b=>b.code===a.code&&b.name===a.name)===i);
}
function findAccountCandidates(legal,query,unit,{limit=4}={}) {
  if(!['school','corporation_general'].includes(unit)) return {status:'scope_unconfirmed',candidates:[],notice:'회계단위를 확인한 뒤 계정 적용 표시를 대조합니다.'};
  const expanded=query.replace(/복사지|A4\s*용지|에이포\s*용지/gi,'복사용지').replace(/프린터\s*용지/g,'프린트용지');
  const normalized=expanded.replace(/\s+/g,''),candidates=[];
  const searchTerms=(expanded.match(/[가-힣A-Za-z0-9]+/g)||[]).map(x=>x.replace(/(?:으로|에서|에는|은|는|을|를|이|가)$/,'')).filter(x=>x.length>=3&&!/^(?:계정|처리|검토|증빙|확인|지급|구입|구매|일반|비용|이거|어떻게|해주세요|알려)/.test(x));
  for(const result of legal.results||[]) for(const annex of result.annexes||[]) {
    if(!['retrieved','partial'].includes(result.status)||!result.law?.lawId||!['retrieved','partial'].includes(annex.status)||annex.bodyRetrieved!==true||!annex.text||!/^별표\s*1$/.test(annex.selector||'')||result.law.name?.replace(/[\sㆍ·]/g,'')!=='사학기관재무회계규칙에대한특례규칙')continue;
    for(const account of parseAccountAppendix(annex.text)) {
      const name=account.name.replace(/\s+/g,'');
      const stem=name.replace(/비$/,'');
      const score=new RegExp(`(?:^|\\D)${account.code}(?:\\D|$)`).test(query)?120:normalized.includes(name)?100:stem.length>=3&&normalized.includes(stem)?70:searchTerms.some(term=>account.description.replace(/\s+/g,'').includes(term))?30:0;
      if(!score||!account.applicable_to[unit])continue;
      candidates.push({...account,score,source_kind:'law_annex',law:result.law,annex:annex.selector||result.request.annex,date_status:annex.dateStatus||'unverified',reference_only:annex.referenceOnly!==false,source_truncated:!!annex.truncated,decision_status:'candidate_requires_review'});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const relevant=candidates[0]?.score>=70?candidates.filter(x=>x.score>=70):candidates;
  const incomplete=(legal.results||[]).some(r=>(r.annexes||[]).some(a=>a.truncated||a.status!=='retrieved'));
  return {status:relevant.length?'candidates_found':'no_verified_match',candidates:relevant.slice(0,limit),total_candidates:relevant.length,omitted_count:Math.max(0,relevant.length-limit),source_complete:!incomplete,notice:'법령 별표의 명칭·적용회계로 찾은 후보입니다. 거래의 실질과 학교 계정 마스터·예산 배정은 별도 확인하며 계정 추천을 확정하지 않습니다.'+(incomplete?' 별표 일부가 미조회 또는 잘렸습니다. 검색되지 않은 계정이 없다는 뜻은 아닙니다.':'')};
}
module.exports={parseAccountAppendix,findAccountCandidates};
