const notificationsQueries = require('../notifications/notifications.queries');
const attendanceQueries = require('./attendance.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');
const geolib = require('geolib');

// ✅ دالة التحقق من الموقع (متعدد الفروع)
async function isLocationValid(userLat, userLng) {
  if (!userLat || !userLng) return null;

  // 1. جلب الفروع من الداتابيز
  const locations = await attendanceQueries.getActiveLocations();
  
  if (!locations || locations.length === 0) {
    // لو مفيش فروع مسجلة، نرفض العملية للأمان
    return null;
  }

  // 2. التحقق من كل فرع
  for (const loc of locations) {
    const distance = geolib.getDistance(
      { latitude: parseFloat(userLat), longitude: parseFloat(userLng) },
      { latitude: loc.Latitude, longitude: loc.Longitude }
    );

    // لو المسافة أقل من أو تساوي المسموح (أو 100 متر افتراضي)
    if (distance <= (loc.AllowedRadius || 100)) {
      return loc; // ✅ نرجع الفرع اللي هو فيه
    }
  }

  return null; // ❌ بعيد عن كل الفروع
}
// ✅ دالة مساعدة لإرسال الإشعار للمديرين
async function notifyManagers(title, message, relatedId) {
  try {
    // ✅ ابعت الـ roles واحد واحد
    const roles = ['Admin', 'SalesManager', 'AccountManager'];
    
    for (const role of roles) {
      await notificationsQueries.createNotificationSmart({
        title,
        message,
        createdBy: 'System',
        formName: 'frm_Attendance',
        relatedId
      }, role); // ✅ هنا بنبعت string
    }
    
  } catch (err) {
    console.error('Failed to notify managers:', err);
  }
}
// الحصول على توقيت مصر
function getEgyptTime() {
  // إنشاء تاريخ بتوقيت السيرفر
  const date = new Date();
  
  // تحويله لتوقيت مصر (UTC+2)
  // ملاحظة: لو التوقيت الصيفي شغال يبقى +3
  // الأفضل نستخدم toLocaleString
  
  const egyptTime = new Date(date.toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
  return egyptTime;
}

// ══════════════════════════════════════════════════════════════
// الهوية والدور من التوكن فقط (req.auth) — البند 11: لا يُقبل أي
// userId/role من الجسم أو الاستعلام لتحديد هوية الفاعل أو المستهدف.
// المستهدف الذاتي دائمًا؛ والاطلاع على غير الذات للمديرين فقط:
// Admin/SalesManager/AccountManager/Account/HrManager.
// ══════════════════════════════════════════════════════════════
function normRole(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

const ATTENDANCE_MANAGER_ROLES = ['admin', 'salesmanager', 'accountmanager', 'account', 'hrmanager'];
function isAttendanceManager(auth) {
  return ATTENDANCE_MANAGER_ROLES.includes(normRole(auth?.role));
}

// يرجع معرّف المستخدم المستهدف أو null عند محاولة غير مدير استهداف غيره
function resolveTargetUserId(req, requestedRaw) {
  const selfId = req.auth.userId;
  const requested = requestedRaw != null && requestedRaw !== ''
    ? parseInt(requestedRaw, 10)
    : null;
  if (!requested || Number.isNaN(requested) || requested === selfId) return selfId;
  return isAttendanceManager(req.auth) ? requested : null;
}

// مديرو الإعفاءات — مرآة IsExemptionManagerRole
// (AttendanceService.cs:2414): Admin/GeneralManager/AccountManager/HrManager
const EXEMPTION_MANAGER_ROLES = ['admin', 'generalmanager', 'accountmanager', 'hrmanager'];
function isExemptionManager(auth) {
  return EXEMPTION_MANAGER_ROLES.includes(normRole(auth?.role));
}

// تسجيل الحضور — الهوية من التوكن فقط؛ userId الجسم يُتجاهل
async function checkIn(req, res) {
  try {
    const userId = req.auth.userId;
    const { latitude, longitude } = req.body;

    // 1. التحقق من الموقع
     const validLocation = await isLocationValid(latitude, longitude);
    
    if (!validLocation) {
      return errorResponse(res, 'أنت خارج نطاق فروع الشركة المصرح بها.', 403);
    }

    // 2. جلب كود البصمة
    const bioCode = await attendanceQueries.getBioCodeByUserId(userId);
    if (!bioCode) {
      return errorResponse(res, 'لم يتم ربط الموظف برقم بصمة', 400);
    }

    // 3. التحقق من تسجيل سابق
    const today = await attendanceQueries.getTodayAttendance(bioCode);
    if (today) {
      return errorResponse(res, 'تم تسجيل الحضور مسبقاً لهذا اليوم', 400);
    }

    // 4. تجهيز التوقيت (مصر)
    const now = getEgyptTime();
    
    // استخراج التاريخ: YYYY-MM-DD
    const dateStr = now.toISOString().split('T')[0];
    
    // استخراج الوقت: HH:MM:SS
    // toTimeString() بيرجع "HH:MM:SS GMT+0200..." هناخد أول جزء بس
    const timeStr = now.toTimeString().split(' ')[0];

    console.log(`CheckIn: Bio=${bioCode}, Date=${dateStr}, Time=${timeStr}`); // للتشخيص

    // 5. التسجيل
    await attendanceQueries.logBiometric(bioCode, dateStr, timeStr);
    await attendanceQueries.checkIn(bioCode, dateStr, timeStr);

        // ✅ 1. هات اسم الموظف
    const employeeName = await attendanceQueries.getEmployeeNameByUserId(userId);
    
    // ✅ 2. جهز وقت مقروء (مثلاً 09:30 AM)
    const timeFormatted = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    // ✅ 3. ابعت الإشعار
    //await notifyManagers(
     // 'تسجيل حضور',
      //`قام الموظف ${employeeName} بتسجيل الحضور الساعة ${timeFormatted}`,
      //userId
    //);

    return res.json({ success: true, message: 'تم تسجيل الحضور بنجاح ✅' });

  } catch (err) {
    console.error('CheckIn Error:', err);
    return errorResponse(res, 'فشل تسجيل الحضور', 500, err.message);
  }
}

// تسجيل الانصراف — الهوية من التوكن فقط
async function checkOut(req, res) {
  try {
    const userId = req.auth.userId;
    const { latitude, longitude } = req.body;

    // 1. التحقق من الموقع
     const validLocation = await isLocationValid(latitude, longitude);
    
    if (!validLocation) {
      return errorResponse(res, 'أنت خارج نطاق فروع الشركة المصرح بها.', 403);
    }

    // 2. جلب كود البصمة
    const bioCode = await attendanceQueries.getBioCodeByUserId(userId);
    
    // 3. التحقق من تسجيل الحضور
    const today = await attendanceQueries.getTodayAttendance(bioCode);

    if (!today) {
      return errorResponse(res, 'يجب تسجيل الحضور أولاً', 400);
    }

    if (today.TimeOut) {
      return errorResponse(res, 'تم تسجيل الانصراف مسبقاً', 400);
    }

    // 4. تجهيز التوقيت (مصر)
    const now = getEgyptTime();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];

    console.log(`CheckOut: Bio=${bioCode}, Date=${dateStr}, Time=${timeStr}`); // للتشخيص

    // 5. التسجيل
    await attendanceQueries.logBiometric(bioCode, dateStr, timeStr);
    await attendanceQueries.checkOut(today.AttendanceID, timeStr);

        // ✅ نفس الخطوات بس العنوان والرسالة مختلفين
    const employeeName = await attendanceQueries.getEmployeeNameByUserId(userId);
    const timeFormatted = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    //await notifyManagers(
      //'تسجيل انصراف',
      //`قام الموظف ${employeeName} بتسجيل الانصراف الساعة ${timeFormatted}`,
      //userId
    //);

    return res.json({ success: true, message: 'تم تسجيل الانصراف بنجاح 👋' });

  } catch (err) {
    console.error('CheckOut Error:', err);
    return errorResponse(res, 'فشل تسجيل الانصراف', 500, err.message);
  }
}

// حالة اليوم — المستهدف عبر resolveTargetUserId (الذات أو مدير)
async function getStatus(req, res) {
  try {
    const targetUserId = resolveTargetUserId(req, req.params.userId);
    if (targetUserId == null) {
      return errorResponse(res, 'غير مصرح لك بعرض حضور مستخدم آخر', 403);
    }
    const bioCode = await attendanceQueries.getBioCodeByUserId(targetUserId);
    
    if (!bioCode) {
      return res.json({ status: 'not_linked' });
    }

    const today = await attendanceQueries.getTodayAttendance(bioCode);
    
    if (!today) {
      return res.json({ status: 'not_checked_in' });
    } else if (today.TimeOut) {
      return res.json({ 
        status: 'checked_out', 
        in: today.TimeIn, 
        out: today.TimeOut 
      });
    } else {
      return res.json({ 
        status: 'checked_in', 
        in: today.TimeIn 
      });
    }

  } catch (err) {
    return errorResponse(res, 'فشل جلب الحالة', 500);
  }
}

// --- الدوال القديمة (للتقارير) — بوابة مديرين: بيانات كل الموظفين ---

function requireAttendanceManager(req, res) {
  if (isAttendanceManager(req.auth)) return true;
  errorResponse(res, 'غير مصرح لك بعرض تقارير الحضور العامة', 403);
  return false;
}

async function getByEmployee(req, res) {
  try {
    if (!requireAttendanceManager(req, res)) return;
    const { biometricCode } = req.params;
    const { startDate, endDate } = req.query;
    const attendance = await attendanceQueries.getAttendanceByEmployee(biometricCode, startDate, endDate);
    return res.json(attendance);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الحضور', 500, err.message);
  }
}

async function getByDate(req, res) {
  try {
    if (!requireAttendanceManager(req, res)) return;
    const { date } = req.query;
    const attendance = await attendanceQueries.getAttendanceByDate(date);
    return res.json(attendance);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الحضور', 500, err.message);
  }
}

async function getMonthlySummary(req, res) {
  try {
    if (!requireAttendanceManager(req, res)) return;
    const { year, month } = req.query;
    const summary = await attendanceQueries.getMonthlyAttendanceSummary(year, month);
    return res.json(summary);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

async function getBiometricLogs(req, res) {
  try {
    if (!requireAttendanceManager(req, res)) return;
    const { biometricCode } = req.params;
    const { date } = req.query;
    const logs = await attendanceQueries.getBiometricLogs(biometricCode, date);
    return res.json(logs);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البصمات', 500, err.message);
  }
}

async function getExemptions(req, res) {
  try {
    const { biometricCode } = req.params;
    // غير المدير يرى إعفاءات كود بصمته هو فقط
    if (!isAttendanceManager(req.auth)) {
      const ownBioCode = await attendanceQueries.getBioCodeByUserId(req.auth.userId);
      if (!ownBioCode || Number(biometricCode) !== Number(ownBioCode)) {
        return errorResponse(res, 'غير مصرح لك بعرض إعفاءات موظف آخر', 403);
      }
    }
    const { startDate, endDate } = req.query;
    const exemptions = await attendanceQueries.getDailyExemptions(biometricCode, startDate, endDate);
    return res.json(exemptions);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الإعفاءات', 500, err.message);
  }
}

// إشعارات الاستثناءات — مرآة Notify* في AttendanceService: الإنشاء
// (معلقًا أو معتمدًا مباشرة) يُخطر مديري الاستثناءات بأدوار بلازور
// الأربعة، والقرار يُخطر منشئ الاستثناء باسمه. فشل الإشعار لا يُفشل
// العملية أبدًا (نفس قاعدة الجزاءات).
async function notifyExemptionManagers(req, { title, message, exemptionId }) {
  try {
    const usernames = await attendanceQueries.getExemptionManagerUsernames();
    for (const username of [...new Set(usernames)]) {
      try {
        await notificationsQueries.createNotification({
          title,
          message,
          recipientUser: username,
          relatedTable: 'DailyExemptions',
          relatedId: exemptionId,
          formName: 'frmDailyExemptions',
          createdBy: req.auth.username,
        });
      } catch (err) {
        console.error('exemption notify (manager):', err.message);
      }
    }
  } catch (err) {
    console.error('exemption notify (managers):', err.message);
  }
}

async function notifyExemptionDecision(req, { exemption, employeeName, approved, reason }) {
  try {
    if (!exemption?.CreatedBy) return;
    const dateText = exemptionDateText(exemption.ExemptionDate);
    const title = approved ? '✅ تم اعتماد الاستثناء' : '❌ تم رفض الاستثناء';
    const message = approved
      ? `تم اعتماد الاستثناء الخاص بالموظف ${employeeName} بتاريخ ${dateText} بسبب (${exemption.ReasonCode}) بواسطة ${req.auth.username}.`
      : `تم رفض الاستثناء الخاص بالموظف ${employeeName} بتاريخ ${dateText} بسبب (${exemption.ReasonCode}) بواسطة ${req.auth.username}.${reason ? ` سبب الرفض: ${reason}` : ''}`;
    await notificationsQueries.createNotification({
      title,
      message,
      recipientUser: exemption.CreatedBy,
      relatedTable: 'DailyExemptions',
      relatedId: exemption.ExemptionID,
      formName: 'frmDailyExemptions',
      createdBy: req.auth.username,
    });
  } catch (err) {
    console.error('exemption notify (decision):', err.message);
  }
}

// تنسيق تاريخ بلازور في رسائل الإشعارات: yyyy/MM/dd
function exemptionDateText(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}/${mm}/${dd}`;
}

// إنشاء إعفاء — مرآة CreateExemptionAsync:2081: لا يُوثق بـ approvedBy
// من الجسم إطلاقًا (كان اعتمادًا ذاتيًا باسم المنشئ). مدير الإعفاءات
// يُعتمد فورًا مع الانعكاس على الحضور، وغيره يبقى Pending بلا معتمِد.
// المستهدف: المدير يرسل employeeId فيُحلّ كود البصمة من الموظف نفسه
// (كما في بلازور) أو bioEmployeeId صراحة؛ وغير المدير يُفرض عليه
// موظفه المرتبط بجلسته ويُتجاهل أي استهداف في الجسم (مرحلة صفر).
// تحققات بلازور: لا تكرار في اليوم نفسه (غير المرفوض)، لا استثناء في
// يوم راحة أسبوعية، والساعات إلزامية للاستثناء الجزئي.
async function createExemption(req, res) {
  try {
    const body = req.body || {};
    if (!body.exemptionDate || !body.reasonCode) {
      return errorResponse(res, 'بيانات الإعفاء غير مكتملة', 400);
    }
    const manager = isExemptionManager(req.auth);

    let employee = null;
    if (!manager) {
      employee = await attendanceQueries.getOwnEmployeeForUser(req.auth.userId);
      if (!employee || !employee.BioEmployeeID) {
        return errorResponse(res, 'لم يتم ربط الموظف برقم بصمة', 400);
      }
    } else if (body.employeeId) {
      employee = await attendanceQueries.getEmployeeForExemption(Number(body.employeeId));
      if (!employee) {
        return errorResponse(res, 'الموظف غير موجود.', 400);
      }
      if (!employee.BioEmployeeID) {
        return errorResponse(res, 'الموظف ليس لديه كود بصمة.', 400);
      }
    } else if (body.bioEmployeeId) {
      employee = await attendanceQueries.getEmployeeByBioCode(Number(body.bioEmployeeId));
      if (!employee) {
        return errorResponse(res, 'الموظف غير موجود.', 400);
      }
    } else {
      return errorResponse(res, 'بيانات الإعفاء غير مكتملة', 400);
    }

    const bioEmployeeId = employee.BioEmployeeID;
    const employeeId = employee.EmployeeID;

    const isFullDay = body.isFullDay !== false;
    if (!isFullDay && !(Number(body.hours) > 0)) {
      return errorResponse(res, 'يرجى تحديد عدد الساعات للاستثناء الجزئي.', 400);
    }

    const duplicate = await attendanceQueries.findDuplicateExemption(bioEmployeeId, body.exemptionDate);
    if (duplicate) {
      return errorResponse(res, 'يوجد استثناء مسجل بالفعل لهذا الموظف في هذا اليوم.', 400);
    }

    const shift = await attendanceQueries.getCurrentShiftOffDays(employeeId, body.exemptionDate);
    if (shift) {
      const dayOfWeek = new Date(body.exemptionDate).getDay();
      const offDays = [shift.OffDay1, shift.OffDay2].filter((d) => d != null).map(Number);
      if (offDays.includes(dayOfWeek)) {
        return errorResponse(res, 'هذا اليوم هو راحة أسبوعية للموظف - لا حاجة لاستثناء.', 400);
      }
    }

    const status = manager ? 'Approved' : 'Pending';
    const { exemptionId, exemption } = await attendanceQueries.createExemption({
      bioEmployeeId,
      employeeId,
      exemptionDate: body.exemptionDate,
      reasonCode: body.reasonCode,
      description: body.description || null,
      isFullDay: body.isFullDay,
      hours: body.hours,
      isDeducted: body.isDeducted,
      notes: body.notes || null,
      createdBy: req.auth.username,
      status,
      approvedBy: manager ? req.auth.username : null,
    });
    if (status === 'Approved') {
      await attendanceQueries.applyExemptionAttendance(exemption);
    }

    const dateText = exemptionDateText(body.exemptionDate);
    if (status === 'Pending') {
      await notifyExemptionManagers(req, {
        title: '📝 استثناء جديد قيد الاعتماد',
        message: `تم تسجيل استثناء جديد للموظف ${employee.FullName} بتاريخ ${dateText} بسبب (${body.reasonCode}) وهو الآن قيد الاعتماد.`,
        exemptionId,
      });
    } else {
      await notifyExemptionManagers(req, {
        title: '✅ تم اعتماد استثناء مباشرة',
        message: `تم تسجيل واعتماد استثناء للموظف ${employee.FullName} بتاريخ ${dateText} بسبب (${body.reasonCode}) بواسطة ${req.auth.username}.`,
        exemptionId,
      });
    }

    return res.json({
      success: true,
      exemptionId,
      status,
      message: status === 'Approved'
        ? 'تم تسجيل الاستثناء واعتماده بنجاح.'
        : 'تم تسجيل الاستثناء وهو قيد الاعتماد من المدير.',
    });
  } catch (err) {
    return errorResponse(res, 'فشل إضافة الإعفاء', 500, err.message);
  }
}

// اعتماد إعفاء — مرآة ApproveExemptionAsync:2175 مع حراس الحالة النهائية
async function approveExemption(req, res) {
  try {
    if (!isExemptionManager(req.auth)) {
      return errorResponse(res, 'ليس لديك صلاحية اعتماد الاستثناءات.', 403);
    }
    const id = parseInt(req.params.id, 10);
    const exemption = await attendanceQueries.getExemptionById(id);
    if (!exemption) return errorResponse(res, 'الاستثناء غير موجود.', 404);
    const status = attendanceQueries.inferExemptionStatus(exemption);
    if (status === 'Approved') return errorResponse(res, 'الاستثناء معتمد بالفعل.', 400);
    if (status === 'Rejected') return errorResponse(res, 'لا يمكن اعتماد استثناء مرفوض.', 400);

    await attendanceQueries.setExemptionDecision(id, {
      status: 'Approved',
      approvedBy: req.auth.username,
    });
    await attendanceQueries.applyExemptionAttendance(exemption);
    const employee = exemption.EmployeeID
      ? await attendanceQueries.getEmployeeForExemption(exemption.EmployeeID)
      : await attendanceQueries.getEmployeeByBioCode(exemption.BioEmployeeID);
    await notifyExemptionDecision(req, {
      exemption,
      employeeName: employee?.FullName || 'موظف',
      approved: true,
    });
    return res.json({ success: true, message: 'تم اعتماد الاستثناء بنجاح.' });
  } catch (err) {
    return errorResponse(res, 'فشل اعتماد الاستثناء', 500, err.message);
  }
}

// رفض إعفاء — مرآة RejectExemptionAsync:2215؛ سبب الرفض يُلحق بالملاحظات
async function rejectExemption(req, res) {
  try {
    if (!isExemptionManager(req.auth)) {
      return errorResponse(res, 'ليس لديك صلاحية رفض الاستثناءات.', 403);
    }
    const id = parseInt(req.params.id, 10);
    const exemption = await attendanceQueries.getExemptionById(id);
    if (!exemption) return errorResponse(res, 'الاستثناء غير موجود.', 404);
    const status = attendanceQueries.inferExemptionStatus(exemption);
    if (status === 'Rejected') return errorResponse(res, 'الاستثناء مرفوض بالفعل.', 400);
    if (status === 'Approved') return errorResponse(res, 'لا يمكن رفض استثناء معتمد. احذفه بدلاً من ذلك.', 400);

    const reason = (req.body && (req.body.reason || req.body.notes)) || null;
    await attendanceQueries.setExemptionDecision(id, {
      status: 'Rejected',
      approvedBy: req.auth.username,
      rejectionReason: reason ? String(reason).trim() : null,
    });
    const employee = exemption.EmployeeID
      ? await attendanceQueries.getEmployeeForExemption(exemption.EmployeeID)
      : await attendanceQueries.getEmployeeByBioCode(exemption.BioEmployeeID);
    await notifyExemptionDecision(req, {
      exemption,
      employeeName: employee?.FullName || 'موظف',
      approved: false,
      reason: reason ? String(reason).trim() : null,
    });
    return res.json({ success: true, message: 'تم رفض الاستثناء.' });
  } catch (err) {
    return errorResponse(res, 'فشل رفض الاستثناء', 500, err.message);
  }
}

async function getCalendar(req, res) {
  try {
    if (!requireAttendanceManager(req, res)) return;
    const { year, month } = req.query;
    const calendar = await attendanceQueries.getCalendar(year, month);
    return res.json(calendar);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل التقويم', 500, err.message);
  }
}

// جلب كل الاستثناءات — مع حالة مستنتجة للصفوف القديمة (InferStatus)
// مرحلة صفر (أمن): القائمة الكاملة لمديري الإعفاءات فقط؛ غيرهم
// تُقيد تلقائيًا بسجلاتهم هم (كانت مفتوحة لأي جلسة بلا قيد).
async function getExemptionsList(req, res) {
  try {
    const filters = {
      date: req.query.date,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      employeeName: req.query.employeeName,
      status: ['Pending', 'Approved', 'Rejected'].includes(req.query.status)
        ? req.query.status
        : null,
      reasonCode: req.query.reasonCode || null,
      isDeducted: req.query.isDeducted === 'true'
        ? true
        : req.query.isDeducted === 'false'
          ? false
          : null,
      employeeId: req.query.employeeId ? Number(req.query.employeeId) : null,
    };
    if (!isExemptionManager(req.auth)) {
      const ownBio = await attendanceQueries.getBioCodeByUserId(req.auth.userId);
      if (!ownBio) return res.json([]);
      filters.bioEmployeeId = ownBio;
      delete filters.employeeName;
    }
    const data = await attendanceQueries.getAllExemptions(filters);
    return res.json(data.map((row) => ({
      ...row,
      Status: attendanceQueries.inferExemptionStatus(row),
    })));
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الاستثناءات', 500);
  }
}

// ══════════════════════════════════════════════════════════════
// الحضور اليدوي للمعفيين من البصمة (البند 38)
// بوابة الكتابة المختارة (موثقة — أشد من صفحة بلازور غير المحروسة):
// Admin/HrManager/AccountManager/Account.
// ══════════════════════════════════════════════════════════════
const MANUAL_ATTENDANCE_WRITE_ROLES = ['admin', 'hrmanager', 'accountmanager', 'account'];
function canWriteManualAttendance(auth) {
  return MANUAL_ATTENDANCE_WRITE_ROLES.includes(normRole(auth?.role));
}

async function getManualAttendance(req, res) {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(String(month))) {
      return errorResponse(res, 'الشهر مطلوب بصيغة YYYY-MM', 400);
    }
    const data = await attendanceQueries.getManualAttendance(String(month));
    return res.json({ success: true, data });
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الحضور اليدوي', 500, err.message);
  }
}

async function saveManualAttendance(req, res) {
  try {
    if (!canWriteManualAttendance(req.auth)) {
      return errorResponse(res, 'غير مصرح لك بحفظ الحضور اليدوي', 403);
    }
    const body = req.body || {};
    const employeeId = body.employeeId ?? body.EmployeeID;
    const attendanceMonth = body.attendanceMonth ?? body.AttendanceMonth;
    if (!employeeId || !attendanceMonth || !/^\d{4}-\d{2}$/.test(String(attendanceMonth))) {
      return errorResponse(res, 'بيانات الحضور اليدوي غير مكتملة', 400);
    }
    await attendanceQueries.saveManualAttendance({
      employeeId: parseInt(employeeId, 10),
      attendanceMonth: String(attendanceMonth),
      presentDays: body.presentDays ?? body.PresentDays ?? 0,
      absenceDays: body.absenceDays ?? body.AbsenceDays ?? 0,
      lateMinutes: body.lateMinutes ?? body.LateMinutes ?? 0,
      notes: body.notes ?? body.Notes ?? null,
    }, req.auth.username);
    return res.json({ success: true, message: 'تم حفظ بيانات الحضور' });
  } catch (err) {
    return errorResponse(res, err.message || 'فشل حفظ الحضور اليدوي', err.statusCode || 500, err.message);
  }
}

// حذف استثناء — مدير إعفاءات فقط (كان مفتوحًا لأي جلسة)
// حذف استثناء — بوابة صفحة بلازور الحرفية (ExemptionsPage):
// Admin أو HrManager (بصيغتيه) أو حامل frmDailyExemptions:Delete.
// (المدير العام ومدير الحسابات يعتمدان ويرفضان لكنهما لا يحذفان في
// بلازور.) الحذف يزيل سجل الحضور المرتبط بالاستثناء المعتمد — مرآة
// DeleteExemptionAsync داخل الاستعلام.
async function removeExemption(req, res) {
  try {
    const role = normRole(req.auth?.role);
    const canDelete = role === 'admin'
      || role === 'hrmanager'
      || (req.auth?.claims instanceof Set && req.auth.claims.has('frmDailyExemptions:Delete'));
    if (!canDelete) {
      return errorResponse(res, 'ليس لديك صلاحية حذف الاستثناءات.', 403);
    }
    const id = parseInt(req.params.id, 10);
    const exemption = await attendanceQueries.getExemptionById(id);
    if (!exemption) return errorResponse(res, 'الاستثناء غير موجود.', 404);
    await attendanceQueries.deleteExemption(id, exemption);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500);
  }
}

// ✅ إحصائيات الموظف — المستهدف من التوكن عبر resolveTargetUserId
async function getStatistics(req, res) {
  try {
    const targetUserId = resolveTargetUserId(req, req.params.userId);
    if (targetUserId == null) {
      return errorResponse(res, 'غير مصرح لك بعرض إحصائيات مستخدم آخر', 403);
    }
    const stats = await attendanceQueries.getEmployeeStatistics(targetUserId);
    return res.json(stats);
  } catch (err) {
    console.error('Stats Error:', err);
    return errorResponse(res, 'فشل جلب الإحصائيات', 500);
  }
}

// ✅ تقرير الحضور — الدور والهوية من التوكن فقط؛ أي role/userId في
// الاستعلام يُتجاهل. غير المدير يُفرض عليه كود بصمته هو مهما طلب.
async function getReport(req, res) {
  try {
    const { startDate, endDate, employeeName } = req.query;
    const isManager = isAttendanceManager(req.auth);

    let filters = { startDate, endDate };

    if (isManager) {
      // مدير: بحث اختياري باسم موظف، أو استهداف مستخدم محدد — بديلان
      // لا يُجمعان: التطبيق يرسل userId دائمًا (هوية العارض نفسه في
      // شاشة سجل الحضور)، فجمع الشرطين بـ AND في الاستعلام كان يقيّد
      // بحث الاسم بكود بصمة العارض ويُرجع صفر صفوف عند بحث المدير
      // عن أي موظف آخر. البحث بالاسم إذن مقدَّم على الاستهداف.
      if (employeeName) {
        filters.employeeName = employeeName;
      } else if (req.query.userId) {
        const targetUserId = resolveTargetUserId(req, req.query.userId);
        if (targetUserId == null) {
          return errorResponse(res, 'غير مصرح لك بعرض تقرير مستخدم آخر', 403);
        }
        const targetBioCode = await attendanceQueries.getBioCodeByUserId(targetUserId);
        if (!targetBioCode) return res.json([]);
        filters.biometricCode = targetBioCode;
      }
    } else {
      // موظف عادي: كود بصمته هو إجباريًا من التوكن
      const bioCode = await attendanceQueries.getBioCodeByUserId(req.auth.userId);

      if (!bioCode) {
        return res.json([]); // لو مش مربوط بموظف، نرجع قايمة فاضية
      }
      filters.biometricCode = bioCode;
    }

    const data = await attendanceQueries.getAdvancedReport(filters);

    return res.json(data);

  } catch (err) {
    console.error('Report Error:', err);
    return errorResponse(res, 'فشل جلب التقرير', 500);
  }
}

module.exports = {
  checkIn,
  checkOut,
  getStatus,
  getByEmployee,
  getByDate,
  getMonthlySummary,
  getBiometricLogs,
  getExemptions,
  createExemption,
  approveExemption,
  rejectExemption,
  getCalendar,
  getExemptionsList,
  removeExemption,
  getStatistics,
  getReport,
  getManualAttendance,
  saveManualAttendance
};