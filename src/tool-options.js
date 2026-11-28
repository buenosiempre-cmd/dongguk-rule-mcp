'use strict';
// Unfinished finance-context tools require an explicit operator opt-in.
const financeContextEnabled=()=>['1','true','on','yes'].includes(String(process.env.DONGGUK_FINANCE_CONTEXT_ENABLED||'').trim().toLowerCase());
module.exports={financeContextEnabled};
