const payrollQueries = require('./payroll.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب مرتبات شهر معين — يدعم month=null للأرشيف (كل الشهور) + branch/paymentStatus/search
async function getByMonth(req, res) {
  try {
    const { month, branchId, paymentStatus, searchText } = req.query;
    const payrolls = await payrollQueries.getPayrollByMonth(month || null, { branchId, paymentStatus, searchText });
    return res.json(payrolls);
  } catch (err) {
    console.error('خطأ في جلب المرتبات:', err);
    return errorResponse(res, 'فشل تحميل المرتبات', 500, err.message);
  }
}

// إحصائيات الرواتب
async function getStats(req, res) {
  try {
    const { month } = req.query;
    const stats = await payrollQueries.getPayrollStats(month || null);
    return res.json(stats);
  } catch (err) {
    console.error('خطأ في جلب إحصائيات الرواتب:', err);
    return errorResponse(res, 'فشل تحميل الإحصائيات', 500, err.message);
  }
}

// جلب قائمة الشهور المتاحة (للـ chips)
async function getMonths(req, res) {
  try {
    const months = await payrollQueries.getPayrollMonths();
    return res.json(months);
  } catch (err) {
    console.error('خطأ في جلب الشهور:', err);
    return errorResponse(res, 'فشل تحميل الشهور', 500, err.message);
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

// جلب مرتب بالـ ID مع التفاصيل — مع تحقق رقمي (يمنع EPARAM Invalid number)
async function getById(req, res) {
  try {
    const { id } = req.params;
    const parsedId = Number(id);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      return errorResponse(res, 'معرّف المرتب غير صالح', 400, 'INVALID_PAYROLL_ID');
    }
    const payroll = await payrollQueries.getPayrollById(parsedId);

    if (!payroll) {
      return notFoundResponse(res, 'المرتب غير موجود');
    }

    const details = await payrollQueries.getPayrollDetails(parsedId);
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

    // إشعار للمديرين - مطابق للبلازور NotifyRoleAsync (frm_Payroll)
    try {
      const title = 'مرتب جديد يحتاج مراجعة';
      const msg = `تم إنشاء مرتب ${req.body.payrollMonth||''} للموظف #${req.body.employeeId} — بواسطة ${req.auth?.username||'system'}`;
      for (const role of ['Admin','AccountManager']) {
        await notificationsQueries.createNotificationSmart({ title, message: msg, createdBy: req.auth?.username||'system', formName: 'frm_Payroll', relatedTable: 'Payroll', relatedId: payrollId }, role);
      }
    } catch(_){}

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

    try {
      const m = status === 'معتمد' ? 'تم اعتماد المرتب' : status === 'مدفوع' ? 'تم صرف المرتب' : `تم تحديث حالة المرتب إلى ${status}`;
      await notificationsQueries.createNotificationSmart({ title: m, message: `${m} #${id} بواسطة ${req.auth?.username||'system'}`, createdBy: req.auth?.username||'system', formName: 'frm_PayrollPayment', relatedTable: 'Payroll', relatedId: parseInt(id) }, 'Admin');
    } catch(_){}

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
  getMonths,
  getStats,
  getByEmployee,
  getById,
  create,
  update,
  updateStatus,
  addDetail,
  deleteDetail
};