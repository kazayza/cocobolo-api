const penaltiesQueries = require('./employee-penalties.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const policies = require('../../shared/authorization.policy');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');

// ══════════════════════════════════════════════════════════════
// نظام الجزاءات — المرحلة ١ (مرآة سابقة الاستثناءات اليومية في
// نمط الولادة بمستويين): دور المنشئ وحده لا يكفي — التوقيع المباشر
// على الموظف بعينه (مطالبة القدرة أو علاقة المدير المباشر) هو ما
// يجعل الجزاء يولد معتمدًا، وغيره يولد معلقًا حتى يعتمده موقع مباشر.
// الهوية والسلطة من التوكن فقط (req.auth) في كل المسارات.
// ══════════════════════════════════════════════════════════════

const { isValidMonth, currentMonth, penaltyError } = penaltiesQueries;

// صاحب توقيع مباشر على هذا الموظف: حامل مطالبة القدرة، أو مديره
// المباشر بحكم علاقة البيانات (Employees.DirectManagerID).
function isDirectSigner(auth, directManagerId) {
  if (policies.employeePenalties.hasDirectSignClaim(auth)) return true;
  const myEmployeeId = auth?.employeeId;
  return myEmployeeId != null && directManagerId != null
    && Number(myEmployeeId) === Number(directManagerId);
}

// بوابة الإنشاء: أحد الأدوار الأربعة المعتمدة، أو كون المنشئ هو
// المدير المباشر للموظف المستهدف.
function canCreateFor(auth, targetEmployee) {
  if (policies.employeePenalties.canCreateByRole(auth)) return true;
  const myEmployeeId = auth?.employeeId;
  return myEmployeeId != null && targetEmployee?.DirectManagerID != null
    && Number(myEmployeeId) === Number(targetEmployee.DirectManagerID);
}

// إشعارات فردية بأسماء المستخدمين (على نمط مجدول الإشعارات)؛ فشل
// الإشعار لا يُفشل العملية نفسها أبدًا.
async function notifyUsernames(usernames, { title, message, createdBy, relatedId }) {
  const unique = [...new Set((usernames || []).filter(Boolean))];
  for (const username of unique) {
    try {
      await notificationsQueries.createNotification({
        title,
        message,
        recipientUser: username,
        relatedTable: 'EmployeePenalties',
        relatedId,
        formName: 'frm_EmployeePenalties',
        createdBy,
      });
    } catch (err) {
      console.error('employee-penalties notify:', err.message);
    }
  }
}

// إنشاء جزاء — POST /api/employee-penalties
async function create(req, res) {
  try {
    const body = req.body || {};
    const employeeId = Number(body.employeeId);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return errorResponse(res, 'معرف الموظف مطلوب ويجب أن يكون رقمًا صحيحًا موجبًا.', 400);
    }
    const type = body.type;
    if (type !== 'Days' && type !== 'Amount') {
      return errorResponse(res, 'نوع الجزاء مطلوب: أيام أو مبلغ.', 400);
    }
    let daysCount = null;
    let fixedAmount = null;
    if (type === 'Days') {
      daysCount = Number(body.daysCount);
      if (!Number.isFinite(daysCount) || daysCount <= 0) {
        return errorResponse(res, 'عدد أيام الجزاء مطلوب ويجب أن يكون أكبر من صفر.', 400);
      }
    } else {
      fixedAmount = Number(body.fixedAmount);
      if (!Number.isFinite(fixedAmount) || fixedAmount <= 0) {
        return errorResponse(res, 'مبلغ الجزاء مطلوب ويجب أن يكون أكبر من صفر.', 400);
      }
    }
    const reason = String(body.reason || '').trim();
    if (!reason) {
      return errorResponse(res, 'سبب الجزاء مطلوب.', 400);
    }
    const requestedMonth = body.targetMonth || currentMonth();
    if (!isValidMonth(requestedMonth)) {
      return errorResponse(res, 'صيغة الشهر المستهدف غير صحيحة (YYYY-MM).', 400);
    }

    const target = await penaltiesQueries.getTargetEmployee(employeeId);
    if (!target) {
      return notFoundResponse(res, 'الموظف غير موجود');
    }

    if (!canCreateFor(req.auth, target)) {
      return errorResponse(res, 'غير مصرح لك بإنشاء جزاء لهذا الموظف.', 403);
    }

    const signer = isDirectSigner(req.auth, target.DirectManagerID);

    let status = 'Pending';
    let computedAmount = null;
    let approvedBy = null;
    let approvedAt = null;
    let finalMonth = requestedMonth;
    let rolledFrom = null;

    if (signer) {
      // الولادة المعتمدة: التجاوز أولًا (بشهر مفتوح)، ثم حساب المبلغ
      // بقيمة يوم الشهر النهائي وتجميده في ComputedAmount.
      const rolled = await penaltiesQueries.rollOverTargetMonth(employeeId, requestedMonth);
      finalMonth = rolled.month;
      rolledFrom = rolled.rolledFrom;
      const computed = await penaltiesQueries.computePenaltyAmount(
        target, { type, daysCount, fixedAmount }, finalMonth,
      );
      computedAmount = computed.computedAmount;
      status = 'Approved';
      approvedBy = req.auth.userId;
      approvedAt = new Date();
    }

    const row = await penaltiesQueries.insertPenalty({
      employeeId,
      type,
      daysCount,
      fixedAmount,
      computedAmount,
      targetMonth: finalMonth,
      reason,
      status,
      createdBy: req.auth.userId,
      approvedBy,
      approvedAt,
    });

    if (status === 'Pending') {
      // إشعار أصحاب التوقيع المباشر وأدوار Admin (باستثناء المنشئ)
      const recipients = (await penaltiesQueries.getPendingNotificationUsernames())
        .filter((username) => username !== req.auth.username);
      await notifyUsernames(recipients, {
        title: 'جزاء جديد بانتظار الاعتماد',
        message: `تم تسجيل جزاء جديد للموظف ${target.FullName} عن شهر ${finalMonth} وهو بانتظار الاعتماد. السبب: ${reason}`,
        createdBy: req.auth.username,
        relatedId: row.Id,
      });
    }

    return res.status(201).json({
      success: true,
      message: status === 'Approved' ? 'تم تسجيل الجزاء واعتماده.' : 'تم تسجيل الجزاء وهو بانتظار الاعتماد.',
      data: { ...row, rolledFrom },
    });
  } catch (err) {
    console.error('employee-penalties.create:', err);
    return errorResponse(res, err.message || 'فشل تسجيل الجزاء', err.statusCode || 500, err.message);
  }
}

// قائمة الجزاءات — GET /api/employee-penalties?employeeId=&status=&month=
async function list(req, res) {
  try {
    const employeeId = req.query.employeeId != null && req.query.employeeId !== ''
      ? Number(req.query.employeeId) : null;
    if (employeeId != null && (!Number.isInteger(employeeId) || employeeId <= 0)) {
      return errorResponse(res, 'معرف الموظف غير صالح.', 400);
    }
    const month = req.query.month || null;
    if (month && !isValidMonth(month)) {
      return errorResponse(res, 'صيغة الشهر غير صحيحة (YYYY-MM).', 400);
    }
    const rows = await penaltiesQueries.listPenalties({
      seeAll: policies.employeePenalties.canViewAll(req.auth),
      myEmployeeId: req.auth.employeeId ?? null,
      userId: req.auth.userId,
      employeeId,
      status: req.query.status || null,
      month,
    });
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('employee-penalties.list:', err);
    return errorResponse(res, 'فشل تحميل الجزاءات', 500, err.message);
  }
}

// طابور الاعتماد — GET /api/employee-penalties/pending
async function listPending(req, res) {
  try {
    const rows = await penaltiesQueries.listPendingForSigner({
      hasClaim: policies.employeePenalties.hasDirectSignClaim(req.auth),
      myEmployeeId: req.auth.employeeId ?? null,
      userId: req.auth.userId,
    });
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('employee-penalties.listPending:', err);
    return errorResponse(res, 'فشل تحميل الجزاءات المعلقة', 500, err.message);
  }
}

// جزاءات موظف — GET /api/employee-penalties/employee/:id
async function getByEmployee(req, res) {
  try {
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return errorResponse(res, 'معرف الموظف غير صالح.', 400);
    }
    const target = await penaltiesQueries.getTargetEmployee(employeeId);
    if (!target) {
      return notFoundResponse(res, 'الموظف غير موجود');
    }
    const myEmployeeId = req.auth.employeeId;
    const visible = policies.employeePenalties.canViewAll(req.auth)
      || (myEmployeeId != null && Number(myEmployeeId) === employeeId)
      || (myEmployeeId != null && target.DirectManagerID != null
        && Number(myEmployeeId) === Number(target.DirectManagerID));
    if (!visible) {
      return errorResponse(res, 'غير مصرح لك بعرض جزاءات هذا الموظف.', 403);
    }
    const rows = await penaltiesQueries.listPenaltiesByEmployee(employeeId);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('employee-penalties.getByEmployee:', err);
    return errorResponse(res, 'فشل تحميل الجزاءات', 500, err.message);
  }
}

// تحميل صف الجزاء لعمليات البت، أو كتابة الرد المناسب وإرجاع null
async function loadPenalty(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    errorResponse(res, 'معرف الجزاء غير صالح.', 400);
    return null;
  }
  const row = await penaltiesQueries.getPenaltyById(id);
  if (!row) {
    notFoundResponse(res, 'الجزاء غير موجود');
    return null;
  }
  return row;
}

// اعتماد — POST /api/employee-penalties/:id/approve
// صاحب توقيع مباشر على موظف الجزاء فقط، وبمنع صارم للاعتماد الذاتي
// (ولو كان الموقع منشئ الجزاء نفسه) — قاعدة صانع/مدقق جديدة بالنظام.
async function approve(req, res) {
  try {
    const row = await loadPenalty(req, res);
    if (!row) return undefined;
    if (Number(row.CreatedBy) === Number(req.auth.userId)) {
      return errorResponse(res, 'لا يجوز اعتماد جزاء أنشأه المعتمِد نفسه.', 403);
    }
    if (!isDirectSigner(req.auth, row.DirectManagerID)) {
      return errorResponse(res, 'غير مصرح لك باعتماد جزاءات هذا الموظف.', 403);
    }
    if (row.Status !== 'Pending') {
      return errorResponse(res, 'لا يمكن اعتماد جزاء غير معلق.', 409);
    }

    const target = await penaltiesQueries.getTargetEmployee(row.EmployeeID);
    const rolled = await penaltiesQueries.rollOverTargetMonth(row.EmployeeID, row.TargetMonth);
    const computed = await penaltiesQueries.computePenaltyAmount(
      target,
      { type: row.PenaltyType, daysCount: row.DaysCount, fixedAmount: row.FixedAmount },
      rolled.month,
    );

    const affected = await penaltiesQueries.approvePenaltyAtomic({
      id: row.Id,
      computedAmount: computed.computedAmount,
      targetMonth: rolled.month,
      approvedBy: req.auth.userId,
    });
    if (!affected) {
      return errorResponse(res, 'تم البت في هذا الجزاء مسبقًا ولا يمكن إعادة البت فيه.', 409);
    }

    const updated = await penaltiesQueries.getPenaltyById(row.Id);

    // إشعار المنشئ + إشعار الموظف المعني عبر حسابه المرتبط إن وجد
    const creatorUsername = await penaltiesQueries.getUsernameByUserId(row.CreatedBy);
    const employeeUsername = await penaltiesQueries.getUsernameByEmployeeId(row.EmployeeID);
    await notifyUsernames([creatorUsername], {
      title: 'تم اعتماد الجزاء',
      message: `تم اعتماد الجزاء المسجل للموظف ${row.EmployeeName} عن شهر ${rolled.month} بمبلغ ${computed.computedAmount} جنيه.`,
      createdBy: req.auth.username,
      relatedId: row.Id,
    });
    await notifyUsernames([employeeUsername], {
      title: 'تم اعتماد جزاء',
      message: `تم اعتماد جزاء بمبلغ ${computed.computedAmount} جنيه يخصم من راتب شهر ${rolled.month}. السبب: ${row.Reason}`,
      createdBy: req.auth.username,
      relatedId: row.Id,
    });

    return res.json({
      success: true,
      message: 'تم اعتماد الجزاء.',
      data: { ...updated, rolledFrom: rolled.rolledFrom },
    });
  } catch (err) {
    console.error('employee-penalties.approve:', err);
    return errorResponse(res, err.message || 'فشل اعتماد الجزاء', err.statusCode || 500, err.message);
  }
}

// رفض — POST /api/employee-penalties/:id/reject
// ملاحظة موثقة: أي ملاحظة في الجسم تُتجاهل — سبب الجزاء الأصلي يبقى
// كما هو في Reason ولا يُستبدل ولا يُلحق به شيء في هذه المرحلة.
async function reject(req, res) {
  try {
    const row = await loadPenalty(req, res);
    if (!row) return undefined;
    if (Number(row.CreatedBy) === Number(req.auth.userId)) {
      return errorResponse(res, 'لا يجوز رفض جزاء أنشأه صاحب القرار نفسه.', 403);
    }
    if (!isDirectSigner(req.auth, row.DirectManagerID)) {
      return errorResponse(res, 'غير مصرح لك برفض جزاءات هذا الموظف.', 403);
    }
    if (row.Status !== 'Pending') {
      return errorResponse(res, 'لا يمكن رفض جزاء غير معلق.', 409);
    }

    const affected = await penaltiesQueries.rejectPenaltyAtomic(row.Id);
    if (!affected) {
      return errorResponse(res, 'تم البت في هذا الجزاء مسبقًا ولا يمكن إعادة البت فيه.', 409);
    }

    const creatorUsername = await penaltiesQueries.getUsernameByUserId(row.CreatedBy);
    await notifyUsernames([creatorUsername], {
      title: 'تم رفض الجزاء',
      message: `تم رفض الجزاء المسجل للموظف ${row.EmployeeName} عن شهر ${row.TargetMonth}.`,
      createdBy: req.auth.username,
      relatedId: row.Id,
    });

    const updated = await penaltiesQueries.getPenaltyById(row.Id);
    return res.json({ success: true, message: 'تم رفض الجزاء.', data: updated });
  } catch (err) {
    console.error('employee-penalties.reject:', err);
    return errorResponse(res, err.message || 'فشل رفض الجزاء', err.statusCode || 500, err.message);
  }
}

// إلغاء — POST /api/employee-penalties/:id/cancel
// للمنشئ أو لصاحب توقيع مباشر على الموظف، ما دام الجزاء لم يدخل
// راتبًا محفوظًا (Applied)؛ ومن الحالات Pending/Approved فقط.
async function cancel(req, res) {
  try {
    const row = await loadPenalty(req, res);
    if (!row) return undefined;
    if (row.Status === 'Applied') {
      return errorResponse(res, 'لا يمكن إلغاء جزاء تم تطبيقه في راتب محفوظ.', 409);
    }
    if (row.Status !== 'Pending' && row.Status !== 'Approved') {
      return errorResponse(res, 'لا يمكن إلغاء جزاء منتهي الحالة.', 409);
    }
    const isCreator = Number(row.CreatedBy) === Number(req.auth.userId);
    if (!isCreator && !isDirectSigner(req.auth, row.DirectManagerID)) {
      return errorResponse(res, 'غير مصرح لك بإلغاء هذا الجزاء.', 403);
    }

    const affected = await penaltiesQueries.cancelPenaltyAtomic(row.Id);
    if (!affected) {
      return errorResponse(res, 'تغيرت حالة الجزاء ولا يمكن إلغاؤه الآن.', 409);
    }

    const updated = await penaltiesQueries.getPenaltyById(row.Id);
    return res.json({ success: true, message: 'تم إلغاء الجزاء.', data: updated });
  } catch (err) {
    console.error('employee-penalties.cancel:', err);
    return errorResponse(res, err.message || 'فشل إلغاء الجزاء', err.statusCode || 500, err.message);
  }
}

// محاكاة قيمة اليوم — GET /api/employee-penalties/preview?employeeId=&month=&days=
async function preview(req, res) {
  try {
    const employeeId = Number(req.query.employeeId);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return errorResponse(res, 'معرف الموظف مطلوب ويجب أن يكون رقمًا صحيحًا موجبًا.', 400);
    }
    const month = req.query.month || currentMonth();
    if (!isValidMonth(month)) {
      return errorResponse(res, 'صيغة الشهر غير صحيحة (YYYY-MM).', 400);
    }
    const days = Number(req.query.days);
    if (!Number.isFinite(days) || days <= 0) {
      return errorResponse(res, 'عدد الأيام مطلوب ويجب أن يكون أكبر من صفر.', 400);
    }
    const target = await penaltiesQueries.getTargetEmployee(employeeId);
    if (!target) {
      return notFoundResponse(res, 'الموظف غير موجود');
    }
    const computed = await penaltiesQueries.computePenaltyAmount(
      target, { type: 'Days', daysCount: days, fixedAmount: null }, month,
    );
    return res.json({
      success: true,
      data: {
        workingDays: computed.workingDays,
        dayValue: computed.dayValue,
        computedAmount: computed.computedAmount,
      },
    });
  } catch (err) {
    console.error('employee-penalties.preview:', err);
    return errorResponse(res, err.message || 'فشل حساب قيمة اليوم', err.statusCode || 500, err.message);
  }
}

module.exports = {
  create,
  list,
  listPending,
  getByEmployee,
  approve,
  reject,
  cancel,
  preview,
  // تُصدَّر للاختبارات المبدئية (stubbed) وللاستخدام الداخلي
  isDirectSigner,
  canCreateFor,
};
