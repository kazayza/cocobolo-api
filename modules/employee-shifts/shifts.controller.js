const shiftsQueries = require('./shifts.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');
const policies = require('../../shared/authorization.policy');

// دالة مساعدة لتوقيت مصر
function getEgyptTime() {
  const date = new Date();
  return new Date(date.toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
}

// جلب شيفتات موظف
async function getByEmployee(req, res) {
  try {
    const { id } = req.params;
    const shifts = await shiftsQueries.getShiftsByEmployee(id);
    return res.json(shifts);
  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل جلب الشيفتات', 500, err.message);
  }
}

// إضافة شيفت — المنشئ من التوكن فقط؛ createdBy الجسم يُتجاهل
async function create(req, res) {
  try {
    const { employeeId, shiftType, startTime, endTime, effectiveFrom } = req.body;

    if (!employeeId || !shiftType || !startTime || !endTime || !effectiveFrom) {
      return errorResponse(res, 'البيانات ناقصة', 400);
    }

    // ✅ تحديد توقيت الإنشاء بتوقيت مصر
    const createdAt = getEgyptTime();

    const shiftId = await shiftsQueries.createShift({
      ...req.body,
      createdBy: req.auth.username,
      createdAt: createdAt // هنبعت الوقت ده للـ Query
    });

    return res.json({
      success: true,
      shiftId,
      message: 'تم إضافة الشيفت وتحديث المواعيد بنجاح'
    });

  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل إضافة الشيفت', 500, err.message);
  }
}

// تعديل شيفت قائم في مكانه — PUT /api/shifts/:id
async function update(req, res) {
  try {
    const { id } = req.params;
    const { shiftType, startTime, endTime, effectiveFrom } = req.body;

    if (!shiftType || !startTime || !endTime || !effectiveFrom) {
      return errorResponse(res, 'البيانات ناقصة', 400);
    }

    await shiftsQueries.updateShift(parseInt(id, 10), {
      shiftType,
      startTime,
      endTime,
      effectiveFrom,
      effectiveTo: req.body.effectiveTo || null,
      offDay1: req.body.offDay1 ?? null,
      offDay2: req.body.offDay2 ?? null,
      biometricCode: req.body.biometricCode ?? null,
    });

    return res.json({ success: true, message: 'تم تعديل الشيفت بنجاح.' });
  } catch (err) {
    console.error(err);
    return errorResponse(res, err.message || 'فشل تعديل الشيفت', err.statusCode || 500, err.message);
  }
}

// حذف شيفت
async function remove(req, res) {
  try {
    const { id } = req.params;
    await shiftsQueries.deleteShift(id);
    return res.json({ success: true, message: 'تم حذف الشيفت' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500);
  }
}

async function getEmployeesShiftsStatus(req, res) {
  try {
    const data = await shiftsQueries.getEmployeesWithCurrentShift();
    return res.json(data);
  } catch (err) {
    return errorResponse(res, 'فشل جلب بيانات الموظفين', 500);
  }
}

// البحث في الشيفتات
async function search(req, res) {
  try {
    const filters = {
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
      shiftType: req.query.shiftType,
      employeeName: req.query.employeeName
    };

    const shifts = await shiftsQueries.searchShifts(filters);
    return res.json(shifts);
  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل البحث في الشيفتات', 500);
  }
}

// جلب جدول الموظف
async function getMySchedule(req, res) {
  try {
    const { userId } = req.params;
    const { year, month } = req.query;

    // مرحلة صفر (أمن): الجدول لصاحبه فقط أو لمدير موارد/حضور —
    // كان أي مستخدم مصادق يقرأ جدول أي مستخدم آخر بمعرفته رقمه.
    if (Number(userId) !== req.auth.userId && !policies.shifts.canViewOthersSchedule(req.auth)) {
      return errorResponse(res, 'غير مصرح لك بعرض جدول ورديات مستخدم آخر', 403);
    }

    if (!year || !month) {
      return errorResponse(res, 'السنة والشهر مطلوبين', 400);
    }

    const data = await shiftsQueries.getMySchedule(userId, year, month);
    return res.json(data);
  } catch (err) {
    return errorResponse(res, 'فشل جلب الجدول', 500, err.message);
  }
}



module.exports = {
  getByEmployee,
  create,
  update,
  remove,
  getEmployeesShiftsStatus,
  search,
  getMySchedule
};