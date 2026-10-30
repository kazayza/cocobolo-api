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

// إنشاء سلفة — الخزينة إلزامية (قرار المالك د٤، تطابق بلازور SaveLoanAsync):
// غياب cashBoxId يُرفض هنا قبل أي استعلام بـ «يرجى اختيار الخزينة».
async function create(req, res) {
  try {
    const { employeeId, amount, totalInstallments, startMonth } = req.body;
    if (!employeeId || !amount) return errorResponse(res, 'الموظف والمبلغ مطلوبان', 400);
    if (!startMonth) return errorResponse(res, 'شهر بداية الخصم مطلوب', 400);
    if (!req.body.cashBoxId) return errorResponse(res, 'يرجى اختيار الخزينة', 400);
    const r = await q.create({
      employeeId,
      amount,
      totalInstallments,
      startMonth,
      cashBoxId: req.body.cashBoxId,
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

// تفاصيل سلفة — GET /api/loans/:id (أي جلسة مصادقة)
// الشكل: { Loan: {...}, Installments: [...] } مرآة GetLoanDetailAsync.
async function getById(req, res) {
  try {
    const detail = await q.getLoanDetail(parseInt(req.params.id, 10));
    if (!detail) return errorResponse(res, 'السلفة غير موجودة', 404);
    return res.json({ success: true, data: detail });
  } catch (e) {
    console.error(e);
    return errorResponse(res, 'فشل تحميل تفاصيل السلفة', 500, e.message);
  }
}

// تأجيل قسط — POST /api/loans/installments/:id/skip { reason?, targetMonth? }
async function skipInstallment(req, res) {
  try {
    const result = await q.skipInstallment(parseInt(req.params.id, 10), {
      reason: req.body?.reason ?? null,
      targetMonth: req.body?.targetMonth,
    }, req.auth?.username || 'system');
    return res.json({ success: true, message: result.message, data: result });
  } catch (e) {
    console.error(e);
    return errorResponse(res, e.message || 'فشل تأجيل القسط', e.statusCode || 500, e.message);
  }
}

// تجزئة قسط — POST /api/loans/installments/:id/split { amountToKeep, reason?, targetMonth? }
async function splitInstallment(req, res) {
  try {
    const result = await q.splitInstallment(parseInt(req.params.id, 10), {
      amountToKeep: req.body?.amountToKeep,
      reason: req.body?.reason ?? null,
      targetMonth: req.body?.targetMonth,
    }, req.auth?.username || 'system');
    return res.json({ success: true, message: result.message, data: result });
  } catch (e) {
    console.error(e);
    return errorResponse(res, e.message || 'فشل تجزئة القسط', e.statusCode || 500, e.message);
  }
}

// تعديل قسط — POST /api/loans/installments/:id/update { newAmount?, newMonth?, notes? }
// وجود مفتاح notes نفسه (ولو فارغًا) يعني استبدال الملاحظات.
async function updateInstallment(req, res) {
  try {
    const body = req.body || {};
    const result = await q.updateInstallment(parseInt(req.params.id, 10), {
      newAmount: body.newAmount,
      newMonth: body.newMonth,
      notes: body.notes,
      notesPresent: Object.prototype.hasOwnProperty.call(body, 'notes'),
    }, req.auth?.username || 'system');
    return res.json({ success: true, message: result.message, data: result });
  } catch (e) {
    console.error(e);
    return errorResponse(res, e.message || 'فشل تعديل القسط', e.statusCode || 500, e.message);
  }
}

module.exports = { getAll, getStats, create, getInstallments, getStatement, cancel, employeesLookup, getById, skipInstallment, splitInstallment, updateInstallment };
