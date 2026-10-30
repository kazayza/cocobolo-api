const queries = require('./off-payroll.queries');
const payrollEngine = require('../payroll/payroll.queries');
const notif = require('../notifications/notifications.queries');
const { errorResponse } = require('../../shared/response.helper');

async function notify(roles, title, msg, relatedId, actor){
  for(const role of roles){
    try{ await notif.createNotificationSmart({title, message:msg, createdBy:actor, formName:'frm_PayrollPayment', relatedTable:'Payroll', relatedId}, role); }catch(_){}
  }
}

async function getAll(req,res){
  try{
    const data = await queries.getList(req.query);
    const stats = await queries.getStats(req.query);
    return res.json({ success:true, data:{ items:data.items, totalCount:data.totalCount, stats }});
  }catch(e){ console.error(e); return errorResponse(res,'فشل تحميل الدفعات',500,e.message); }
}
async function create(req,res){
  try{
    const { employeeId, amount, paymentType, paymentMonth, description } = req.body;
    if(!employeeId || !amount) return errorResponse(res,'الموظف والمبلغ مطلوبان',400);
    const r = await queries.create({ employeeId, amount, paymentType, paymentMonth, description }, req.auth?.username||'system');
    await notify(['Admin','AccountManager'], 'دفعة خارج الراتب جديدة', `طلب ${paymentType||'مكافأة'} بقيمة ${amount} جـ للموظف #${employeeId} — بواسطة ${req.auth?.username||''}`, r.payrollId, req.auth?.username||'system');
    return res.status(201).json({ success:true, message:'تم إنشاء طلب الدفعة بنجاح وسيتم مراجعته', data:r });
  }catch(e){ console.error(e); return errorResponse(res,e.message||'فشل الإنشاء',500,e.message); }
}
// الاعتماد والصرف يمران بمحرك الرواتب نفسه (البند 19): الدفعة خارج
// الراتب هي صف Payroll موسوم [OFFPAYROLL] يمر بـ ApprovePayrollAsync /
// PayOneAsync:733 في بلازور — اعتماد حقيقي بحارس مراجع (Admin/
// AccountManager)، وصرف بحركة خزينة فعلية وحارس رصيد واشتراط اعتماد
// سابق، في معاملة واحدة. لم يعد الصرف يقلب الحالة متجاهلًا cashBoxId.
async function approve(req,res){
  try{
    const id = parseInt(req.params.id, 10);
    await payrollEngine.approvePayroll(id, req.auth);
    await notify(['Admin'], 'اعتماد دفعة خارج الراتب', `تم اعتماد الدفعة #${req.params.id} بواسطة ${req.auth?.username||''}`, req.params.id, req.auth?.username||'system');
    return res.json({ success:true, message:'تم الاعتماد بنجاح' });
  }catch(e){ return errorResponse(res, e.message || 'فشل الاعتماد', e.statusCode || 500, e.message); }
}
async function pay(req,res){
  try{
    const id = parseInt(req.params.id, 10);
    const cashBoxId = parseInt(req.body?.cashBoxId, 10);
    if (!Number.isInteger(cashBoxId) || cashBoxId <= 0) {
      return errorResponse(res, 'اختيار الخزينة مطلوب', 400);
    }
    const result = await payrollEngine.payPayroll(id, cashBoxId, req.auth);
    return res.json({ success:true, message:'تم الصرف من الخزينة بنجاح', data: result });
  }catch(e){ return errorResponse(res, e.message || 'فشل الصرف', e.statusCode || 500, e.message); }
}

module.exports = { getAll, create, approve, pay };
