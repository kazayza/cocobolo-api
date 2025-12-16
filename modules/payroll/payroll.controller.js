const payrollQueries = require('./payroll.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب مرتبات شهر معين
async function getByMonth(req, res) {
  try {
    const { month } = req.query;

    if (!month) {
      return errorResponse(res, 'الشهر مطلوب (مثال: 2025-01)', 400);
    }

    const payrolls = await payrollQueries.getPayrollByMonth(month);
    return res.json(payrolls);
  } catch (err) {
    console.error('خطأ في جلب المرتبات:', err);
    return errorResponse(res, 'فشل تحميل المرتبات', 500, err.message);
  }
}

// جلب مرتبات موظف
async function getByEmployee(req, res) {
  try {
    const { employeeId } = req.params;
    const payrolls = await payrollQueries.getPayrollByEmployee(employeeId);
    return res.json(payrolls);
  } catch (err) {
    console.error('خطأ في جلب المرتبات:', err);
    return errorResponse(res, 'فشل تحميل المرتبات', 500, err.message);
  }
}

// جلب مرتب بالـ ID مع التفاصيل
async function getById(req, res) {
  try {
    const { id } = req.params;
    const payroll = await payrollQueries.getPayrollById(id);

    if (!payroll) {
      return notFoundResponse(res, 'المرتب غير موجود');
    }

    const details = await payrollQueries.getPayrollDetails(id);
    payroll.details = details;

    return res.json(payroll);
  } catch (err) {
    console.error('خطأ في جلب المرتب:', err);
    return errorResponse(res, 'فشل تحميل المرتب', 500, err.message);
  }
}

// إنشاء مرتب جديد
async function create(req, res) {
  try {
    const { employeeId, payrollMonth, basicSalary } = req.body;

    if (!employeeId || !payrollMonth || !basicSalary) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const payrollId = await payrollQueries.createPayroll(req.body);

    return res.json({
      success: true,
      payrollId: payrollId,
      message: 'تم إنشاء المرتب بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء المرتب:', err);
    return errorResponse(res, 'فشل إنشاء المرتب', 500, err.message);
  }
}

// تعديل مرتب
async function update(req, res) {
  try {
    const { id } = req.params;

    await payrollQueries.updatePayroll(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل المرتب بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المرتب:', err);
    return errorResponse(res, 'فشل تعديل المرتب', 500, err.message);
  }
}

// تحديث حالة الدفع
async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, paymentDate } = req.body;

    if (!status) {
      return errorResponse(res, 'الحالة مطلوبة', 400);
    }

    await payrollQueries.updatePaymentStatus(id, status, paymentDate);

    return res.json({
      success: true,
      message: 'تم تحديث حالة الدفع بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تحديث الحالة:', err);
    return errorResponse(res, 'فشل تحديث الحالة', 500, err.message);
  }
}

// إضافة تفصيل للمرتب
async function addDetail(req, res) {
  try {
    const { id } = req.params;
    const { detailType, amount } = req.body;

    if (!detailType || !amount) {
      return errorResponse(res, 'النوع والمبلغ مطلوبين', 400);
    }

    const detailId = await payrollQueries.addPayrollDetail(id, req.body);

    return res.json({
      success: true,
      detailId: detailId,
      message: 'تم إضافة التفصيل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة التفصيل:', err);
    return errorResponse(res, 'فشل إضافة التفصيل', 500, err.message);
  }
}

// حذف تفصيل
async function deleteDetail(req, res) {
  try {
    const { detailId } = req.params;

    await payrollQueries.deletePayrollDetail(detailId);

    return res.json({
      success: true,
      message: 'تم حذف التفصيل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف التفصيل:', err);
    return errorResponse(res, 'فشل حذف التفصيل', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getByMonth,
  getByEmployee,
  getById,
  create,
  update,
  updateStatus,
  addDetail,
  deleteDetail
};