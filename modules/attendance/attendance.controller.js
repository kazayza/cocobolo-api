const attendanceQueries = require('./attendance.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');
const geolib = require('geolib');

// إحداثيات الشركة (ثابتة مؤقتاً)
// ⚠️ غيّر دي لإحداثياتك الحقيقية
const COMPANY_LOCATION = {
  latitude: 30.055852, 
  longitude: 31.0353408
};
const ALLOWED_RADIUS = 100; // متر

function isWithinRange(userLat, userLng) {
  if (!userLat || !userLng) return false;
  const distance = geolib.getDistance(
    { latitude: parseFloat(userLat), longitude: parseFloat(userLng) },
    COMPANY_LOCATION
  );
  return distance <= ALLOWED_RADIUS;
}

// تسجيل الحضور
async function checkIn(req, res) {
  try {
    const { userId, latitude, longitude } = req.body;

    // 1. التحقق من الموقع
    if (!isWithinRange(latitude, longitude)) {
      return errorResponse(res, 'أنت خارج نطاق الشركة. يرجى الاقتراب والتجربة مرة أخرى.', 403);
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

    // 4. التسجيل
    const now = new Date();
    // ضبط الوقت بتوقيت مصر (UTC+2 أو UTC+3)
    // لكن الـ Server غالباً UTC، فـ new Date() مناسب لو الـ DB بتخزن UTC
    // لو الـ DB بتخزن Local، ممكن نحتاج تعديل بسيط
    
    const timeString = now.toTimeString().split(' ')[0]; // HH:MM:SS

    await attendanceQueries.logBiometric(bioCode, now, timeString);
    await attendanceQueries.checkIn(bioCode, timeString);

    return res.json({ success: true, message: 'تم تسجيل الحضور بنجاح ✅' });

  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل تسجيل الحضور', 500, err.message);
  }
}

// تسجيل الانصراف
async function checkOut(req, res) {
  try {
    const { userId, latitude, longitude } = req.body;

    if (!isWithinRange(latitude, longitude)) {
      return errorResponse(res, 'أنت خارج نطاق الشركة', 403);
    }

    const bioCode = await attendanceQueries.getBioCodeByUserId(userId);
    const today = await attendanceQueries.getTodayAttendance(bioCode);

    if (!today) {
      return errorResponse(res, 'يجب تسجيل الحضور أولاً', 400);
    }

    if (today.TimeOut) {
      return errorResponse(res, 'تم تسجيل الانصراف مسبقاً', 400);
    }

    const now = new Date();
    const timeString = now.toTimeString().split(' ')[0];

    await attendanceQueries.logBiometric(bioCode, now, timeString);
    await attendanceQueries.checkOut(today.AttendanceID, timeString);

    return res.json({ success: true, message: 'تم تسجيل الانصراف بنجاح 👋' });

  } catch (err) {
    console.error(err);
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
  getCalendar
};