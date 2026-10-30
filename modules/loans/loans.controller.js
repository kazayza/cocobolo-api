const q = require('./loans.queries');
const notif = require('../notifications/notifications.queries');
const { errorResponse } = require('../../shared/response.helper');

async function getAll(req, res) {
  try {
    const data = await q.getLoans(req.query);
    const stats = await q.getStats();
    return res.json({ success: true, data: { items: data.items, totalCount: data.totalCount, stats } });
  } catch (e) {
    console.error(e);
    return errorResponse(res, 'فشل تحميل السلف', 500, e.message);
  }
}

async function getStats(req, res) {
  try {
    const s = await q.getStats();
    return res.json(s);
  } catch (e) {
    return errorResponse(res, 'فشل الإحصائيات', 500, e.message);
  }
}

// إنشاء سلفة — CashBoxId اختياري بالقرار الموثق في loans.queries:
// عند إرساله تُفرض حركة الصرف وحارس الرصيد، وعند غيابه لا حركة.
async function create(req, res) {
  try {
    const { employeeId, amount, totalInstallments, startMonth } = req.body;
    if (!employeeId || !amount) return errorResponse(res, 'الموظف والمبلغ مطلوبان', 400);
    if (!startMonth) return errorResponse(res, 'شهر بداية الخصم مطلوب', 400);
    const r = await q.create({
      employeeId,
      amount,
      totalInstallments,
      startMonth,
      cashBoxId: req.body.cashBoxId || null,
      notes: req.body.notes || null,
      purpose: req.body.purpose || null,
    }, req.auth?.username || 'system');
    try {
      for (const role of ['Admin', 'AccountManager']) {
        await notif.createNotificationSmart({
          title: 'سلفة جديدة',
          message: `طلب سلفة ${amount} ج للموظف #${employeeId}`,
          createdBy: req.auth?.username || 'system',
          formName: 'frm_LoansPage',
          relatedTable: 'EmployeeLoans',
          relatedId: r.loanId,
        }, role);
      }
    } catch (_) {}
    return res.status(201).json({ success: true, message: 'تم إنشاء السلفة', data: r });
  } catch (e) {
    console.error(e);
    return errorResponse(res, e.message || 'فشل الإنشاء', e.statusCode || 500, e.message);
  }
}

// أقساط شهر — GET /api/loans/installments?month=YYYY-MM
async function getInstallments(req, res) {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const data = await q.getMonthInstallments(month);
    return res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    return errorResponse(res, 'فشل تحميل أقساط الشهر', 500, e.message);
  }
}

// كشف موظف — GET /api/loans/statement/:employeeId
async function getStatement(req, res) {
  try {
    const statement = await q.getEmployeeStatement(parseInt(req.params.employeeId, 10));
    if (!statement) return errorResponse(res, 'الموظف غير موجود', 404);
    // التطبيق يقرأ كائن الكشف مباشرة من جسم الاستجابة
    return res.json(statement);
  } catch (e) {
    console.error(e);
    return errorResponse(res, 'فشل تحميل كشف الموظف', 500, e.message);
  }
}

// إلغاء سلفة — POST /api/loans/:id/cancel (المنفذ من التوكن فقط)
async function cancel(req, res) {
  try {
    const result = await q.cancelLoan(parseInt(req.params.id, 10), req.auth?.username || 'system');
    return res.json({ success: true, message: 'تم إلغاء السلفة وعكس الأثر المالي بنجاح', data: result });
  } catch (e) {
    console.error(e);
    return errorResponse(res, e.message || 'فشل إلغاء السلفة', e.statusCode || 500, e.message);
  }
}

// بحث موظفين — GET /api/loans/employees-lookup?search=
async function employeesLookup(req, res) {
  try {
    const data = await q.getEmployeesLookup(req.query.search || null);
    return res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    return errorResponse(res, 'فشل بحث الموظفين', 500, e.message);
  }
}

module.exports = { getAll, getStats, create, getInstallments, getStatement, cancel, employeesLookup };
