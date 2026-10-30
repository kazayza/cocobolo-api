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
// مرحلة صفر الموارد — تجميد المسارات القديمة: الحالات التي تُقفل
// المرتب أمام أي تعديل قديم (الدفع يتم عبر محرك الدورة فقط، بحركة
// خزينة وخصم أقساط؛ والملغي لا يُبعث من هذه المسارات).
const LEGACY_LOCKED_STATUSES = ['مدفوع', 'ملغي'];

async function create(req, res) {
  try {
    const { employeeId, payrollMonth, basicSalary } = req.body;

    if (!employeeId || !payrollMonth || !basicSalary) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    // لا إنشاء مباشر بحالة «مدفوع» — الصرف عبر محرك الدورة فقط.
    if (req.body.paymentStatus === 'مدفوع') {
      return errorResponse(res, 'لا يمكن إنشاء مرتب بحالة مدفوع مباشرة؛ الصرف يتم عبر دورة الرواتب.', 400);
    }

    // منع التكرار: مرتب قائم لنفس الموظف والشهر (غير ملغي).
    const duplicateId = await payrollQueries.findActivePayrollForMonth(employeeId, payrollMonth);
    if (duplicateId) {
      return errorResponse(res, 'يوجد مرتب قائم لهذا الموظف في نفس الشهر.', 409);
    }

    // المنشئ من التوكن فقط؛ createdBy الجسم يُتجاهل.
    const payrollId = await payrollQueries.createPayroll({ ...req.body, createdBy: req.auth.username });

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

// تعديل مرتب — ممنوع على مرتب مدفوع أو ملغي (كان يعدّل المدفوع بحرية)
async function update(req, res) {
  try {
    const { id } = req.params;

    const currentStatus = await payrollQueries.getLegacyPayrollStatus(id);
    if (currentStatus == null) {
      return errorResponse(res, 'المرتب غير موجود', 404);
    }
    if (LEGACY_LOCKED_STATUSES.includes(currentStatus)) {
      return errorResponse(res, 'لا يمكن تعديل مرتب مدفوع أو ملغي.', 400);
    }

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

// تحديث حالة الدفع — المسار القديم لا يصرّف أبدًا: الانتقال إلى
// «مدفوع» من هنا كان يتم بلا حركة خزينة ولا خصم أقساط ولا فحص رصيد.
// الصرف الحقيقي عبر POST /:id/pay (محرك الدورة) فقط.
async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, paymentDate } = req.body;

    if (!status) {
      return errorResponse(res, 'الحالة مطلوبة', 400);
    }

    if (status === 'مدفوع') {
      return errorResponse(res, 'لا يمكن تحويل المرتب إلى مدفوع من هنا؛ استخدم صرف دورة الرواتب حتى تُسجَّل حركة الخزينة وتُخصم الأقساط.', 400);
    }

    const currentStatus = await payrollQueries.getLegacyPayrollStatus(id);
    if (currentStatus == null) {
      return errorResponse(res, 'المرتب غير موجود', 404);
    }
    if (LEGACY_LOCKED_STATUSES.includes(currentStatus)) {
      return errorResponse(res, 'مرتب مدفوع أو ملغي لا تتغير حالته من هذا المسار.', 400);
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

// إضافة تفصيل للمرتب — ممنوعة على مرتب مدفوع أو ملغي،
// والمنشئ من التوكن فقط.
async function addDetail(req, res) {
  try {
    const { id } = req.params;
    const { detailType, amount } = req.body;

    if (!detailType || !amount) {
      return errorResponse(res, 'النوع والمبلغ مطلوبين', 400);
    }

    const parentStatus = await payrollQueries.getLegacyPayrollStatus(id);
    if (parentStatus == null) {
      return errorResponse(res, 'المرتب غير موجود', 404);
    }
    if (LEGACY_LOCKED_STATUSES.includes(parentStatus)) {
      return errorResponse(res, 'لا يمكن إضافة تفاصيل إلى مرتب مدفوع أو ملغي.', 400);
    }

    const detailId = await payrollQueries.addPayrollDetail(id, { ...req.body, createdBy: req.auth.username });

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

// حذف تفصيل — ممنوع إذا كان المرتب الأب مدفوعًا أو ملغيًا
async function deleteDetail(req, res) {
  try {
    const { detailId } = req.params;

    const parentStatus = await payrollQueries.getDetailParentStatus(detailId);
    if (parentStatus == null) {
      return errorResponse(res, 'التفصيل غير موجود', 404);
    }
    if (LEGACY_LOCKED_STATUSES.includes(parentStatus)) {
      return errorResponse(res, 'لا يمكن حذف تفاصيل من مرتب مدفوع أو ملغي.', 400);
    }

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

// ══════════════════════════════════════════════════════════════
// دورة الرواتب الشهرية (البند 34): حساب جماعي ← حفظ تشغيل
// PendingReview ← اعتماد/رفض ← صرف من خزينة. حارس المراجع الأضيق
// (Admin/AccountManager) يُفرض داخل المحرك نفسه.
// ══════════════════════════════════════════════════════════════

function validMonth(month) {
  return typeof month === 'string' && /^\d{4}-\d{2}$/.test(month);
}

// حساب جماعي بلا حفظ — POST /api/payroll/calculate { month, employeeId? }
async function calculate(req, res) {
  try {
    const { month, employeeId } = req.body || {};
    if (!validMonth(month)) return errorResponse(res, 'الشهر مطلوب بصيغة YYYY-MM', 400);
    const { sql, connectDB } = require('../../core/database');
    if (employeeId) {
      const pool = await connectDB();
      const one = await payrollQueries.calculateOne(pool, parseInt(employeeId, 10), month);
      return res.json({ success: true, data: [one] });
    }
    const data = await payrollQueries.calculateMonth(month);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('payroll.calculate:', err);
    return errorResponse(res, err.message || 'فشل حساب الرواتب', err.statusCode || 500, err.message);
  }
}

// حساب + حفظ تشغيل للمراجعة — POST /api/payroll/runs { month }
async function createRun(req, res) {
  try {
    const { month } = req.body || {};
    if (!validMonth(month)) return errorResponse(res, 'الشهر مطلوب بصيغة YYYY-MM', 400);
    const result = await payrollQueries.saveRun(month, req.auth.username);
    try {
      for (const role of ['Admin', 'AccountManager']) {
        await notificationsQueries.createNotificationSmart({
          title: 'كشف رواتب جديد بانتظار المراجعة',
          message: `تم تسجيل كشف رواتب شهر ${month} بعدد ${result.count} موظف وبإجمالي صافي ${result.totalNet} جـ وهو الآن بانتظار مراجعة مدير الحسابات.`,
          createdBy: req.auth.username,
          formName: 'frm_Payroll',
          relatedTable: 'PayrollRuns',
          relatedId: result.runId,
        }, role);
      }
    } catch (_) {}
    return res.status(201).json({
      success: true,
      message: `تم حفظ وإرسال ${result.count} راتب للمراجعة`,
      data: result,
    });
  } catch (err) {
    console.error('payroll.createRun:', err);
    return errorResponse(res, err.message || 'فشل حفظ كشف الرواتب', err.statusCode || 500, err.message);
  }
}

// قائمة التشغيلات — GET /api/payroll/runs?month=YYYY-MM
async function getRuns(req, res) {
  try {
    const runs = await payrollQueries.getRuns(req.query.month || null);
    return res.json({ success: true, data: runs });
  } catch (err) {
    console.error('payroll.getRuns:', err);
    return errorResponse(res, 'فشل تحميل كشوف الرواتب', 500, err.message);
  }
}

// اعتماد — POST /api/payroll/:id/approve (هنا :id هو معرّف المرتب)
async function approve(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await payrollQueries.approvePayroll(id, req.auth);
    return res.json({ success: true, message: 'تم اعتماد المرتب بنجاح', data: result });
  } catch (err) {
    console.error('payroll.approve:', err);
    return errorResponse(res, err.message || 'فشل الاعتماد', err.statusCode || 500, err.message);
  }
}

// رفض — POST /api/payroll/:id/reject { reason? }
async function reject(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await payrollQueries.rejectPayroll(id, req.auth, req.body?.reason || null);
    return res.json({ success: true, message: 'تم رفض المرتب', data: result });
  } catch (err) {
    console.error('payroll.reject:', err);
    return errorResponse(res, err.message || 'فشل الرفض', err.statusCode || 500, err.message);
  }
}

// صرف من خزينة — POST /api/payroll/:id/pay { cashBoxId }
async function pay(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cashBoxId = parseInt(req.body?.cashBoxId, 10);
    if (!Number.isInteger(cashBoxId) || cashBoxId <= 0) {
      return errorResponse(res, 'اختيار الخزينة مطلوب', 400);
    }
    const result = await payrollQueries.payPayroll(id, cashBoxId, req.auth);
    return res.json({ success: true, message: 'تم صرف المرتب بنجاح', data: result });
  } catch (err) {
    console.error('payroll.pay:', err);
    return errorResponse(res, err.message || 'فشل الصرف', err.statusCode || 500, err.message);
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
  deleteDetail,
  calculate,
  createRun,
  getRuns,
  approve,
  reject,
  pay
};