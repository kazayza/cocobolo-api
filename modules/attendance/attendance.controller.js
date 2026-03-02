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

// تسجيل الحضور
// تسجيل الحضور
async function checkIn(req, res) {
  try {
    const { userId, latitude, longitude } = req.body;

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

// تسجيل الانصراف
// تسجيل الانصراف
async function checkOut(req, res) {
  try {
    const { userId, latitude, longitude } = req.body;

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

// حالة اليوم
async function getStatus(req, res) {
  try {
    const { userId } = req.params;
    const bioCode = await attendanceQueries.getBioCodeByUserId(userId);
    
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

// --- الدوال القديمة (للتقارير) ---

async function getByEmployee(req, res) {
  try {
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
    const { date } = req.query;
    const attendance = await attendanceQueries.getAttendanceByDate(date);
    return res.json(attendance);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الحضور', 500, err.message);
  }
}

async function getMonthlySummary(req, res) {
  try {
    const { year, month } = req.query;
    const summary = await attendanceQueries.getMonthlyAttendanceSummary(year, month);
    return res.json(summary);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

async function getBiometricLogs(req, res) {
  try {
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
    const { startDate, endDate } = req.query;
    const exemptions = await attendanceQueries.getDailyExemptions(biometricCode, startDate, endDate);
    return res.json(exemptions);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الإعفاءات', 500, err.message);
  }
}

async function createExemption(req, res) {
  try {
    const exemptionId = await attendanceQueries.createExemption(req.body);
    return res.json({ success: true, exemptionId });
  } catch (err) {
    return errorResponse(res, 'فشل إضافة الإعفاء', 500, err.message);
  }
}

async function getCalendar(req, res) {
  try {
    const { year, month } = req.query;
    const calendar = await attendanceQueries.getCalendar(year, month);
    return res.json(calendar);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل التقويم', 500, err.message);
  }
}

// جلب كل الاستثناءات
async function getExemptionsList(req, res) {
  try {
    const filters = {
      date: req.query.date,
      employeeName: req.query.employeeName
    };
    const data = await attendanceQueries.getAllExemptions(filters);
    return res.json(data);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل الاستثناءات', 500);
  }
}

// حذف استثناء
async function removeExemption(req, res) {
  try {
    const { id } = req.params;
    await attendanceQueries.deleteExemption(id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500);
  }
}

// ✅ دالة لاستقبال طلب الإحصائيات من الموبايل
async function getStatistics(req, res) {
  try {
    const { userId } = req.params;
    
    // بننادي على الدالة اللي عملناها في الخطوة الأولى
    const stats = await attendanceQueries.getEmployeeStatistics(userId);
    
    // بنرد على الموبايل بالبيانات
    return res.json(stats);
  } catch (err) {
    console.error('Stats Error:', err);
    return errorResponse(res, 'فشل جلب الإحصائيات', 500);
  }
}

// ✅ دالة استقبال طلب التقرير من الموبايل
async function getReport(req, res) {
  try {
    // 1. استلام المدخلات من الرابط (Query Parameters)
    const { startDate, endDate, employeeName, userId, role } = req.query;

    // 2. تحديد الصلاحيات (مين المدير؟)
    const managerRoles = ['Admin', 'SalesManager', 'AccountManager', 'Account']; 
    // ^^^ ضيف أي رول تانية هنا لو نسيت حاجة
    
    // هل المستخدم الحالي مدير؟
    // (بنحول الرول لـ lowercase احتياطي عشان لو مكتوبة admin أو Admin)
    const isManager = managerRoles.some(r => r.toLowerCase() === (role || '').toLowerCase());

    // 3. تجهيز الفلاتر
    let filters = { startDate, endDate };

    if (isManager) {
      // ✅ لو مدير: يقدر يبحث بأي اسم موظف
      if (employeeName) filters.employeeName = employeeName;
    } else {
      // ⛔ لو موظف عادي: 
      // أولاً: نتجاهل أي employeeName باعتها (عشان ميشوفش غيره)
      // ثانياً: نجيب كود البصمة بتاعه هو ونفلتر بيه إجباري
      const bioCode = await attendanceQueries.getBioCodeByUserId(userId);
      
      if (!bioCode) {
        return res.json([]); // لو مش مربوط بموظف، نرجع قايمة فاضية
      }
      filters.biometricCode = bioCode;
    }

    // 4. تنفيذ الاستعلام
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
  getCalendar,
  getExemptionsList,
  removeExemption,
  getStatistics,
  getReport
};