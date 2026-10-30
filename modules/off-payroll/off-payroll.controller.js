const queries = require('./off-payroll.queries');
const payrollEngine = require('../payroll/payroll.queries');
const notif = require('../notifications/notifications.queries');
const { errorResponse } = require('../../shared/response.helper');

async function notify(roles, title, msg, relatedId, actor) {
  for (const role of roles) {
    try { await notif.createNotificationSmart({ title, message: msg, createdBy: actor, formName: 'frm_PayrollPayment', relatedTable: 'Payroll', relatedId }, role); } catch (_) {}
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function getAll(req, res) {
  try {
    const data = await queries.getList(req.query);
    const stats = await queries.getStats(req.query);
    return res.json({ success: true, data: { items: data.items, totalCount: data.totalCount, stats } });
  } catch (e) { console.error(e); return errorResponse(res, 'فشل تحميل الدفعات', 500, e.message); }
}

// تحقق الإنشاء بمرآة SaveOffPayrollPaymentAsync: موظف ومبلغ أكبر من
// صفر ووصف إلزامي ونوع مقيد وشهر بصيغة yyyy-MM.
async function create(req, res) {
  try {
    const { employeeId, amount, paymentType, paymentMonth, referenceMonth, description, reason } = req.body || {};
    const empId = parseInt(employeeId, 10);
    if (!Number.isInteger(empId) || empId <= 0) return errorResponse(res, 'يجب اختيار الموظف', 400);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return errorResponse(res, 'قيمة الدفعة يجب أن تكون أكبر من صفر', 400);
    if (!description || !String(description).trim()) return errorResponse(res, 'وصف الدفعة مطلوب', 400);
    const type = paymentType || 'BonusSeparate';
    if (!queries.PAYMENT_TYPES[type]) return errorResponse(res, 'نوع الدفعة غير صالح', 400);
    const month = paymentMonth || referenceMonth;
    if (!month || !MONTH_RE.test(String(month))) return errorResponse(res, 'صيغة الشهر غير صحيحة (yyyy-MM)', 400);
    if (referenceMonth && !MONTH_RE.test(String(referenceMonth))) return errorResponse(res, 'صيغة الشهر المرجعي غير صحيحة (yyyy-MM)', 400);
    const r = await queries.create(
      { employeeId: empId, amount: amt, paymentType: type, paymentMonth: String(month), referenceMonth: referenceMonth ? String(referenceMonth) : null, description, reason },
      req.auth?.username || 'system',
    );
    await notify(['Admin', 'AccountManager'], 'دفعة خارج الراتب جديدة', `طلب ${queries.PAYMENT_TYPES[type]} بقيمة ${amt} جـ للموظف #${empId} — بواسطة ${req.auth?.username || ''}`, r.payrollId, req.auth?.username || 'system');
    return res.status(201).json({ success: true, message: 'تم إنشاء طلب الدفعة بنجاح وسيتم مراجعته', data: r });
  } catch (e) { return errorResponse(res, e.message || 'فشل الإنشاء', e.statusCode || 500, e.message); }
}

async function pendingInstallments(req, res) {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (!Number.isInteger(employeeId) || employeeId <= 0) return errorResponse(res, 'معرّف الموظف غير صالح', 400);
    const items = await queries.getPendingInstallments(employeeId);
    return res.json({ success: true, data: items });
  } catch (e) { console.error(e); return errorResponse(res, 'فشل تحميل الأقساط المعلقة', 500, e.message); }
}

// الاعتماد والصرف والرفض يمرون بمحرك الرواتب نفسه: الدفعة خارج الراتب
// هي صف Payroll موسوم [OFFPAYROLL] يمر بـ ApprovePayrollAsync /
// RejectPayrollAsync / PayOneAsync في بلازور — اعتماد بحارس مراجع
// (Admin/AccountManager)، وصرف بحركة خزينة فعلية وحارس رصيد واشتراط
// اعتماد سابق، في معاملة واحدة. الصرف بمخصصات أقساط يمر بمسار
// المقاصة PayOneWithLoanAllocationAsync في وحدة خارج الراتب نفسها.
async function approve(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await payrollEngine.approvePayroll(id, req.auth);
    await notify(['Admin'], 'اعتماد دفعة خارج الراتب', `تم اعتماد الدفعة #${req.params.id} بواسطة ${req.auth?.username || ''}`, req.params.id, req.auth?.username || 'system');
    return res.json({ success: true, message: 'تم الاعتماد بنجاح' });
  } catch (e) { return errorResponse(res, e.message || 'فشل الاعتماد', e.statusCode || 500, e.message); }
}

async function reject(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await payrollEngine.rejectPayroll(id, req.auth, req.body?.reason || null);
    return res.json({ success: true, message: 'تم رفض الدفعة' });
  } catch (e) { return errorResponse(res, e.message || 'فشل الرفض', e.statusCode || 500, e.message); }
}

async function cancel(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await payrollEngine.cancelPayroll(id, req.auth);
    return res.json({ success: true, message: 'تم إلغاء الدفعة' });
  } catch (e) { return errorResponse(res, e.message || 'فشل الإلغاء', e.statusCode || 500, e.message); }
}

async function pay(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cashBoxId = parseInt(req.body?.cashBoxId, 10);
    if (!Number.isInteger(cashBoxId) || cashBoxId <= 0) {
      return errorResponse(res, 'اختيار الخزينة مطلوب', 400);
    }
    const allocations = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    if (allocations.length > 0) {
      const result = await queries.payWithAllocations(id, cashBoxId, allocations, req.auth);
      return res.json({ success: true, message: 'تم الصرف من الخزينة مع مقاصة أقساط السلف', data: result });
    }
    const result = await payrollEngine.payPayroll(id, cashBoxId, req.auth);
    return res.json({ success: true, message: 'تم الصرف من الخزينة بنجاح', data: result });
  } catch (e) { return errorResponse(res, e.message || 'فشل الصرف', e.statusCode || 500, e.message); }
}

module.exports = { getAll, create, pendingInstallments, approve, reject, cancel, pay };
