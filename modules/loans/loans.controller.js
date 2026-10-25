const q=require('./loans.queries');
const notif=require('../notifications/notifications.queries');
const {errorResponse}=require('../../shared/response.helper');
async function getAll(req,res){ try{ const data=await q.getLoans(req.query); const stats=await q.getStats(); return res.json({success:true, data:{items:data.items, totalCount:data.totalCount, stats}});}catch(e){ console.error(e); return errorResponse(res,'فشل تحميل السلف',500,e.message);} }
async function getStats(req,res){ try{ const s=await q.getStats(); return res.json(s);}catch(e){ return errorResponse(res,'فشل الإحصائيات',500,e.message);} }
async function create(req,res){
  try{
    const {employeeId, amount, totalInstallments, monthlyInstallment, startMonth, notes} = req.body;
    if(!employeeId||!amount) return errorResponse(res,'الموظف والمبلغ مطلوبان',400);
    const r=await q.create({employeeId, amount, totalInstallments, monthlyInstallment, startMonth, notes}, req.auth?.username||'system');
    try{ for(const role of ['Admin','AccountManager']) await notif.createNotificationSmart({title:'سلفة جديدة', message:`طلب سلفة ${amount} ج للموظف #${employeeId}`, createdBy:req.auth?.username||'system', formName:'frm_LoansPage', relatedTable:'EmployeeLoans', relatedId:r.loanId}, role); }catch(_){}
    return res.status(201).json({success:true, message:'تم إنشاء السلفة', data:r});
  }catch(e){ console.error(e); return errorResponse(res,e.message||'فشل الإنشاء',500,e.message); }
}
module.exports={ getAll, getStats, create };
