const expensesQueries = require('./expenses.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// هوية المنشئ تأتي دائمًا من التوكن (req.auth) — أي createdBy في جسم
// الطلب يُتجاهل تمامًا (ExpenseService.cs:811: المنشئ = مستخدم الجلسة).
function usernameOf(req) {
  return req.auth?.username || 'system';
}

// جلب مجموعات المصروفات — العقد الكامل (أبناء/مصروفات/إجماليات/تدقيق)
async function getGroups(req, res) {
  try {
    const groups = await expensesQueries.getExpenseGroups();
    return res.json(groups);
  } catch (err) {
    console.error('خطأ في جلب مجموعات المصروفات:', err);
    return errorResponse(res, 'فشل تحميل المجموعات', 500, err.message);
  }
}

// جلب الخزائن — نشطة فقط مع الفرع والرصيد الحالي الموحّد
async function getCashboxes(req, res) {
  try {
    const cashboxes = await expensesQueries.getCashboxes();
    return res.json(cashboxes);
  } catch (err) {
    console.error('خطأ في جلب الخزائن:', err);
    return errorResponse(res, 'فشل تحميل الخزائن', 500, err.message);
  }
}

// إحصائيات القائمة — تحترم عقد الفلتر الكامل (GetStatsAsync)
async function getSummary(req, res) {
  try {
    const summary = await expensesQueries.getExpensesSummary(
      expensesQueries.parseFilter(req.query));
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب ملخص المصروفات:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// جلب المصروفات — عقد ExpenseFilterDto كاملًا مع الصفحات
async function getAll(req, res) {
  try {
    const result = await expensesQueries.getAllExpenses(
      expensesQueries.parseFilter(req.query));
    return res.json(result);
  } catch (err) {
    console.error('خطأ في جلب المصروفات:', err);
    return errorResponse(res, 'فشل تحميل المصروفات', 500, err.message);
  }
}

// إضافة مصروف جديد — CreatedBy من التوكن فقط
async function create(req, res) {
  try {
    const { expenseName, expenseGroupId, cashBoxId, amount, notes } = req.body;
    const createdBy = usernameOf(req);

    if (!expenseName) return errorResponse(res, 'اسم المصروف مطلوب', 400);
    if (!expenseGroupId) return errorResponse(res, 'مجموعة المصروف مطلوبة', 400);
    if (!cashBoxId) return errorResponse(res, 'الخزينة مطلوبة', 400);
    if (!amount || amount <= 0) return errorResponse(res, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر', 400);

    const expenseId = await expensesQueries.createExpense({ ...req.body, createdBy });

    // الإشعار سلوك API مقصود ومُبقى (بند 15 — قرار مالك: يبقى)
    try {
      await notificationsQueries.createNotificationSmart({
        title: 'مصروف جديد',
        message: `تم إضافة مصروف "${expenseName}" بقيمة ${amount} ج.م بواسطة ${createdBy}. البيان: ${notes || ''}`,
        createdBy,
        relatedId: expenseId,
        formName: 'frm_Expenses'
      }, 'AccountManager');
    } catch (notifError) {
      console.error('فشل إرسال الإشعار:', notifError);
    }

    return res.json({
      success: true,
      expenseId: expenseId,
      message: 'تم إضافة المصروف بنجاح'
    });

  } catch (err) {
    console.error('خطأ في إضافة المصروف:', err);
    return errorResponse(res, err.message || 'فشل إضافة المصروف', err.statusCode || 400, err.message);
  }
}

// تعديل مصروف
async function update(req, res) {
  try {
    const { id } = req.params;
    const { expenseName, amount } = req.body;

    if (!expenseName) {
      return errorResponse(res, 'اسم المصروف مطلوب', 400);
    }
    if (!amount || amount <= 0) {
      return errorResponse(res, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر', 400);
    }

    await expensesQueries.updateExpense(id, { ...req.body, createdBy: usernameOf(req) });

    return res.json({
      success: true,
      message: 'تم تعديل المصروف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المصروف:', err);
    return errorResponse(res, err.message || 'فشل تعديل المصروف', err.statusCode || 400, err.message);
  }
}

// حذف مصروف
async function remove(req, res) {
  try {
    const { id } = req.params;
    await expensesQueries.deleteExpense(id, usernameOf(req));
    return res.json({
      success: true,
      message: 'تم حذف المصروف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف المصروف:', err);
    return errorResponse(res, err.message || 'فشل حذف المصروف', err.statusCode || 400, err.message);
  }
}

async function getGroupsByParent(req, res) {
  try {
    const { parentGroupName } = req.query;
    const groups = await expensesQueries.getExpenseGroupsByParent(parentGroupName);
    return res.json(groups);
  } catch (err) {
    console.error('خطأ في جلب مجموعات المصروفات حسب الأب:', err);
    return errorResponse(res, 'فشل تحميل المجموعات حسب المجموعة الأم', 500, err.message);
  }
}

// جلب مصروف بالـ ID — DTO التعديل المحدود الحقول
async function getById(req, res) {
  try {
    const { id } = req.params;
    const expense = await expensesQueries.getExpenseById(id);
    if (!expense) {
      return res.status(404).json({ success: false, message: 'المصروف غير موجود' });
    }
    return res.json(expense);
  } catch (err) {
    console.error('Error getting expense:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
}

// داشبورد المصروفات — تعريفات GetDashboardDataAsync العشرة (فرع اختياري)
async function getDashboard(req, res) {
  try {
    const branchId = req.query.branchId ? parseInt(req.query.branchId, 10) : null;
    const dashboard = await expensesQueries.getExpenseDashboard(
      Number.isNaN(branchId) ? null : branchId);
    return res.json(dashboard);
  } catch (err) {
    console.error('❌ getDashboard (expenses):', err.message);
    return errorResponse(res, 'فشل تحميل الداشبورد', 500, err.message);
  }
}

// التقرير الإجمالي الشهري (GetMonthlySummaryAsync)
async function getMonthlySummary(req, res) {
  try {
    const summary = await expensesQueries.getMonthlySummary(
      expensesQueries.parseFilter(req.query));
    return res.json(summary);
  } catch (err) {
    console.error('❌ getMonthlySummary (expenses):', err.message);
    return errorResponse(res, 'فشل تحميل الملخص الشهري', 500, err.message);
  }
}

// بيانات الطباعة — عقد فلاتر التقرير، حد 10000 صف، خلف canView في المسارات
async function getPrintData(req, res) {
  try {
    const filter = expensesQueries.parseFilter(req.query);
    const mode = String(req.query.mode || 'detail').toLowerCase() === 'summary'
      ? 'summary' : 'detail';
    const data = await expensesQueries.getPrintData(filter, mode);
    return res.json(data);
  } catch (err) {
    console.error('❌ getPrintData (expenses):', err.message);
    return errorResponse(res, 'فشل تحميل بيانات الطباعة', 500, err.message);
  }
}

// اقتراحات أسماء المصروفات السابقة (أصول فقط)
async function getNameSuggestions(req, res) {
  try {
    const suggestions = await expensesQueries.getNameSuggestions();
    return res.json(suggestions);
  } catch (err) {
    console.error('❌ getNameSuggestions (expenses):', err.message);
    return errorResponse(res, 'فشل تحميل الاقتراحات', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// التصدير CSV (UTF-8 مع BOM) — انحراف معلن عن إكسيل بلازور:
// الـ API بلا مكتبة xlsx، فالتصدير CSV بنفس أعمدة ملف بلازور.
// ═══════════════════════════════════════════════════════════
function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvDocument(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
// BOM صريح: \uFEFF في أول الملف حتى يقرأ Excel العربية UTF-8 صحيحًا
function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csvDocument(rows));
}

async function exportDetailed(req, res) {
  try {
    const filter = expensesQueries.parseFilter(req.query);
    const data = await expensesQueries.getPrintData(filter, 'detail');
    const rows = [['التاريخ', 'الفرع', 'اسم المصروف / البيان', 'المجموعة / النوع', 'الخزينة', 'المستلم', 'المبلغ', 'ملاحظات']];
    for (const e of data.items) {
      const name = e.IsAdvance && e.AdvanceMonths ? `${e.ExpenseName} (مقدم ${e.AdvanceMonths} أشهر)` : e.ExpenseName;
      rows.push([
        String(e.ExpenseDate || '').slice(0, 10).replace(/-/g, '/'),
        e.BranchName || 'غير محدد', name, e.FullGroupPath || e.ExpenseGroupName || '',
        e.CashBoxName || '', e.Torecipient || '', e.Amount, e.Notes || '',
      ]);
    }
    rows.push(['', '', '', '', '', 'الإجمالي الكلي:', data.totalAmount, '']);
    return sendCsv(res, 'expenses-detailed.csv', rows);
  } catch (err) {
    console.error('❌ exportDetailed (expenses):', err.message);
    return errorResponse(res, 'فشل تصدير التقرير التفصيلي', 500, err.message);
  }
}

async function exportMonthly(req, res) {
  try {
    const filter = expensesQueries.parseFilter(req.query);
    const summary = await expensesQueries.getMonthlySummary(filter);
    const rows = [['الشهر', 'عدد العمليات', 'الإجمالي', 'التغير عن السابق %']];
    for (const m of summary.Months) {
      rows.push([m.MonthLabel, m.Count, m.Total, m.HasPrevious ? m.ChangePercent : '—']);
    }
    rows.push(['الإجمالي', summary.TotalCount, summary.GrandTotal, '']);
    rows.push(['متوسط الشهر', '', summary.MonthlyAverage, '']);
    return sendCsv(res, 'expenses-monthly.csv', rows);
  } catch (err) {
    console.error('❌ exportMonthly (expenses):', err.message);
    return errorResponse(res, 'فشل تصدير الملخص الشهري', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// مجموعات المصروفات — إنشاء/تعديل/حذف (CreatedBy من التوكن)
// ═══════════════════════════════════════════════════════════
async function createGroup(req, res) {
  try {
    const { expenseGroupName, parentGroupId } = req.body;
    if (!expenseGroupName || !expenseGroupName.trim()) {
      return errorResponse(res, 'اسم المجموعة مطلوب', 400);
    }
    const id = await expensesQueries.createExpenseGroup({
      expenseGroupName: expenseGroupName.trim(),
      parentGroupId: parentGroupId || null,
      createdBy: usernameOf(req),
    });
    return successResponse(res, { groupId: id }, 'تم إنشاء المجموعة بنجاح', 201);
  } catch (err) {
    console.error('❌ createGroup:', err.message);
    return errorResponse(res, err.message || 'فشل إنشاء المجموعة', err.statusCode || 400, err.message);
  }
}

async function updateGroup(req, res) {
  try {
    const { expenseGroupName, parentGroupId } = req.body;
    if (!expenseGroupName || !expenseGroupName.trim()) {
      return errorResponse(res, 'اسم المجموعة مطلوب', 400);
    }
    await expensesQueries.updateExpenseGroup(req.params.id, {
      expenseGroupName: expenseGroupName.trim(),
      parentGroupId: parentGroupId || null,
    }, usernameOf(req));
    return successResponse(res, null, 'تم التحديث');
  } catch (err) {
    console.error('❌ updateGroup:', err.message);
    return errorResponse(res, err.message || 'فشل تعديل المجموعة', err.statusCode || 400, err.message);
  }
}

async function deleteGroup(req, res) {
  try {
    await expensesQueries.deleteExpenseGroup(req.params.id, usernameOf(req));
    return successResponse(res, null, 'تم الحذف');
  } catch (err) {
    console.error('❌ deleteGroup:', err.message);
    return errorResponse(res, err.message || 'فشل حذف المجموعة', err.statusCode || 400, err.message);
  }
}

// تصدير الدوال
module.exports = {
  createGroup,
  updateGroup,
  deleteGroup,
  getDashboard,
  getMonthlySummary,
  getPrintData,
  getNameSuggestions,
  exportDetailed,
  exportMonthly,
  getGroups,
  getCashboxes,
  getSummary,
  getAll,
  create,
  update,
  remove,
  getGroupsByParent,
  getById
};
