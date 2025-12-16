const expensesQueries = require('./expenses.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب مجموعات المصروفات
async function getGroups(req, res) {
  try {
    const groups = await expensesQueries.getExpenseGroups();
    return res.json(groups);
  } catch (err) {
    console.error('خطأ في جلب مجموعات المصروفات:', err);
    return errorResponse(res, 'فشل تحميل المجموعات', 500, err.message);
  }
}

// جلب الخزائن
async function getCashboxes(req, res) {
  try {
    const cashboxes = await expensesQueries.getCashboxes();
    return res.json(cashboxes);
  } catch (err) {
    console.error('خطأ في جلب الخزائن:', err);
    return errorResponse(res, 'فشل تحميل الخزائن', 500, err.message);
  }
}

// ملخص المصروفات
async function getSummary(req, res) {
  try {
    const summary = await expensesQueries.getExpensesSummary();
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب ملخص المصروفات:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// جلب كل المصروفات
async function getAll(req, res) {
  try {
    const { search, groupId, startDate, endDate } = req.query;
    const expenses = await expensesQueries.getAllExpenses(search, groupId, startDate, endDate);
    return res.json(expenses);
  } catch (err) {
    console.error('خطأ في جلب المصروفات:', err);
    return errorResponse(res, 'فشل تحميل المصروفات', 500, err.message);
  }
}

// إضافة مصروف جديد
async function create(req, res) {
  try {
    const { expenseName, expenseGroupId, cashBoxId, amount } = req.body;

    // التحقق من البيانات المطلوبة
    if (!expenseName) {
      return errorResponse(res, 'اسم المصروف مطلوب', 400);
    }

    if (!expenseGroupId) {
      return errorResponse(res, 'مجموعة المصروف مطلوبة', 400);
    }

    if (!cashBoxId) {
      return errorResponse(res, 'الخزينة مطلوبة', 400);
    }

    if (!amount || amount <= 0) {
      return errorResponse(res, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر', 400);
    }

    const expenseId = await expensesQueries.createExpense(req.body);

    return res.json({
      success: true,
      expenseId: expenseId,
      message: 'تم إضافة المصروف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة المصروف:', err);
    return errorResponse(res, 'فشل إضافة المصروف', 500, err.message);
  }
}

// تعديل مصروف
async function update(req, res) {
  try {
    const { id } = req.params;
    const { expenseName, amount } = req.body;

    // التحقق من البيانات المطلوبة
    if (!expenseName) {
      return errorResponse(res, 'اسم المصروف مطلوب', 400);
    }

    if (!amount || amount <= 0) {
      return errorResponse(res, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر', 400);
    }

    await expensesQueries.updateExpense(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل المصروف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المصروف:', err);
    return errorResponse(res, 'فشل تعديل المصروف', 500, err.message);
  }
}

// حذف مصروف
async function remove(req, res) {
  try {
    const { id } = req.params;

    await expensesQueries.deleteExpense(id);

    return res.json({
      success: true,
      message: 'تم حذف المصروف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف المصروف:', err);
    return errorResponse(res, 'فشل حذف المصروف', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getGroups,
  getCashboxes,
  getSummary,
  getAll,
  create,
  update,
  remove
};