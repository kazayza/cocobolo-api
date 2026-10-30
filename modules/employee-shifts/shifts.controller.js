const shiftsQueries = require('./shifts.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');
const policies = require('../../shared/authorization.policy');

// دالة مساعدة لتوقيت مصر
function getEgyptTime() {
  const date = new Date();
  return new Date(date.toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
}

// تحقق يوم راحة أسبوعي (OffDay1/OffDay2): القيم بايتات DayOfWeek بنظام
// .NET — 0=الأحد .. 6=السبت. ثلاث حالات:
//  - غياب القيمة (null/undefined): «غير مضبوط» — value=null و clear=false
//    (في التعديل يُبقي الاستعلام القيمة المخزنة عبر ISNULL كما في البلازور).
//  - القيمة −1: إشارة «مسح صريح» — value=null و clear=true (في التعديل
//    تُفرَّغ القيمة المخزنة فعلًا؛ وفي الإنشاء تُعامل كغياب وتُكتب NULL).
//  - أي قيمة أخرى حاضرة: يجب أن تكون عددًا صحيحًا من 0 إلى 6.
// يرجع { ok: true, value: رقم أو null, clear: bool } أو { ok: false }.
function normalizeOffDay(value) {
  if (value === null || value === undefined) return { ok: true, value: null, clear: false };
  if (typeof value === 'boolean') return { ok: false };
  if (typeof value === 'string' && value.trim() === '') return { ok: false };
  const n = Number(value);
  if (n === -1) return { ok: true, value: null, clear: true };
  if (!Number.isInteger(n) || n < 0 || n > 6) return { ok: false };
  return { ok: true, value: n, clear: false };
}

const OFF_DAY_ERROR = 'قيمة يوم الراحة غير صحيحة: يجب أن تكون رقمًا صحيحًا من 0 (الأحد) إلى 6 (السبت).';

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

    // أيام الراحة الأسبوعية: اختيارية عند الإنشاء، وتُتحقق عند حضورها.
    // إشارة المسح (−1) عند الإنشاء تُعامل كغياب: تُكتب NULL من value.
    const offDay1 = normalizeOffDay(req.body.offDay1);
    const offDay2 = normalizeOffDay(req.body.offDay2);
    if (!offDay1.ok || !offDay2.ok) {
      return errorResponse(res, OFF_DAY_ERROR, 400);
    }

    // ✅ تحديد توقيت الإنشاء بتوقيت مصر
    const createdAt = getEgyptTime();

    const shiftId = await shiftsQueries.createShift({
      ...req.body,
      offDay1: offDay1.value,
      offDay2: offDay2.value,
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

    // نفس تحقق أيام الراحة المطبق عند الإنشاء؛ الغياب (null) يحفظ
    // القيمة القائمة عبر ISNULL في الاستعلام كما كان، وإشارة المسح
    // (−1 ← clear) تُفرّغها فعلًا عبر علم المسح المرافق للقيمة.
    const offDay1 = normalizeOffDay(req.body.offDay1);
    const offDay2 = normalizeOffDay(req.body.offDay2);
    if (!offDay1.ok || !offDay2.ok) {
      return errorResponse(res, OFF_DAY_ERROR, 400);
    }

    await shiftsQueries.updateShift(parseInt(id, 10), {
      shiftType,
      startTime,
      endTime,
      effectiveFrom,
      effectiveTo: req.body.effectiveTo || null,
      offDay1: offDay1.value,
      offDay1Clear: offDay1.clear,
      offDay2: offDay2.value,
      offDay2Clear: offDay2.clear,
      biometricCode: req.body.biometricCode ?? null,
    });

    return res.json({ success: true, message: 'تم تعديل الشيفت بنجاح.' });
  } catch (err) {
    console.error(err);
    return errorResponse(res, err.message || 'فشل تعديل الشيفت', err.statusCode || 500, err.message);
  }
}

// حذف شيفت — حارس الحذف في طبقة الاستعلامات يرفض الشيفت الساري أو
// الوحيد بـ 409 ورسالة عربية واضحة تمر هنا كما هي.
async function remove(req, res) {
  try {
    const { id } = req.params;
    await shiftsQueries.deleteShift(id);
    return res.json({ success: true, message: 'تم حذف الشيفت' });
  } catch (err) {
    console.error(err);
    return errorResponse(res, err.message || 'فشل الحذف', err.statusCode || 500, err.message);
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
  getMySchedule,
  normalizeOffDay
};