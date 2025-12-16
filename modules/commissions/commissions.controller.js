const commissionsQueries = require('./commissions.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب كل العمولات
async function getAll(req, res) {
  try {
    const { employeeId, year, month } = req.query;
    const commissions = await commissionsQueries.getAllCommissions({
      employeeId, year, month
    });
    return res.json(commissions);
  } catch (err) {
    console.error('خطأ في جلب العمولات:', err);
    return errorResponse(res, 'فشل تحميل العمولات', 500, err.message);
  }
}

// ملخص عمولات موظف
async function getEmployeeSummary(req, res) {
  try {
    const { employeeId } = req.params;
    const { year } = req.query;
    const summary = await commissionsQueries.getEmployeeCommissionsSummary(employeeId, year);
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// ملخص العمولات الشهري
async function getMonthlySummary(req, res) {
  try {
    const { year, month } = req.query;

    if (!year || !month) {
      return errorResponse(res, 'السنة والشهر مطلوبين', 400);
    }

    const summary = await commissionsQueries.getMonthlyCommissionsSummary(year, month);
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// إضافة عمولة
async function create(req, res) {
  try {
    const { transactionId, employeeId, commissionRate, createdBy } = req.body;

    if (!transactionId || !employeeId || !commissionRate) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const assignmentId = await commissionsQueries.createCommission(req.body);

    return res.json({
      success: true,
      assignmentId: assignmentId,
      message: 'تم إضافة العمولة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة العمولة:', err);
    return errorResponse(res, 'فشل إضافة العمولة', 500, err.message);
  }
}

// اعتماد عمولة
async function approve(req, res) {
  try {
    const { id } = req.params;
    const { approvedBy } = req.body;

    if (!approvedBy) {
      return errorResponse(res, 'اسم المعتمد مطلوب', 400);
    }

    await commissionsQueries.approveCommission(id, approvedBy);

    return res.json({
      success: true,
      message: 'تم اعتماد العمولة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في اعتماد العمولة:', err);
    return errorResponse(res, 'فشل اعتماد العمولة', 500, err.message);
  }
}

// اعتماد كل عمولات شهر
async function approveMonthly(req, res) {
  try {
    const { year, month, approvedBy } = req.body;

    if (!year || !month || !approvedBy) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    await commissionsQueries.approveMonthlyCommissions(year, month, approvedBy);

    return res.json({
      success: true,
      message: 'تم اعتماد كل عمولات الشهر بنجاح'
    });
  } catch (err) {
    console.error('خطأ في اعتماد العمولات:', err);
    return errorResponse(res, 'فشل اعتماد العمولات', 500, err.message);
  }
}

// حذف عمولة
async function remove(req, res) {
  try {
    const { id } = req.params;

    await commissionsQueries.deleteCommission(id);

    return res.json({
      success: true,
      message: 'تم حذف العمولة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف العمولة:', err);
    return errorResponse(res, 'فشل حذف العمولة', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getEmployeeSummary,
  getMonthlySummary,
  create,
  approve,
  approveMonthly,
  remove
};