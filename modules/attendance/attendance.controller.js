const attendanceQueries = require('./attendance.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب سجل الحضور لموظف
async function getByEmployee(req, res) {
  try {
    const { biometricCode } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return errorResponse(res, 'تاريخ البداية والنهاية مطلوبين', 400);
    }

    const attendance = await attendanceQueries.getAttendanceByEmployee(
      biometricCode, startDate, endDate
    );
    return res.json(attendance);
  } catch (err) {
    console.error('خطأ في جلب الحضور:', err);
    return errorResponse(res, 'فشل تحميل الحضور', 500, err.message);
  }
}

// جلب سجل الحضور لتاريخ معين
async function getByDate(req, res) {
  try {
    const { date } = req.query;

    if (!date) {
      return errorResponse(res, 'التاريخ مطلوب', 400);
    }

    const attendance = await attendanceQueries.getAttendanceByDate(date);
    return res.json(attendance);
  } catch (err) {
    console.error('خطأ في جلب الحضور:', err);
    return errorResponse(res, 'فشل تحميل الحضور', 500, err.message);
  }
}

// جلب ملخص الحضور الشهري
async function getMonthlySummary(req, res) {
  try {
    const { year, month } = req.query;

    if (!year || !month) {
      return errorResponse(res, 'السنة والشهر مطلوبين', 400);
    }

    const summary = await attendanceQueries.getMonthlyAttendanceSummary(year, month);
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// جلب سجلات البصمة
async function getBiometricLogs(req, res) {
  try {
    const { biometricCode } = req.params;
    const { date } = req.query;

    if (!date) {
      return errorResponse(res, 'التاريخ مطلوب', 400);
    }

    const logs = await attendanceQueries.getBiometricLogs(biometricCode, date);
    return res.json(logs);
  } catch (err) {
    console.error('خطأ في جلب البصمات:', err);
    return errorResponse(res, 'فشل تحميل البصمات', 500, err.message);
  }
}

// جلب الإعفاءات
async function getExemptions(req, res) {
  try {
    const { biometricCode } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return errorResponse(res, 'تاريخ البداية والنهاية مطلوبين', 400);
    }

    const exemptions = await attendanceQueries.getDailyExemptions(
      biometricCode, startDate, endDate
    );
    return res.json(exemptions);
  } catch (err) {
    console.error('خطأ في جلب الإعفاءات:', err);
    return errorResponse(res, 'فشل تحميل الإعفاءات', 500, err.message);
  }
}

// إضافة إعفاء
async function createExemption(req, res) {
  try {
    const { bioEmployeeId, exemptionDate, reasonCode, approvedBy } = req.body;

    if (!bioEmployeeId || !exemptionDate || !reasonCode || !approvedBy) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const exemptionId = await attendanceQueries.createExemption(req.body);

    return res.json({
      success: true,
      exemptionId: exemptionId,
      message: 'تم إضافة الإعفاء بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الإعفاء:', err);
    return errorResponse(res, 'فشل إضافة الإعفاء', 500, err.message);
  }
}

// جلب التقويم
async function getCalendar(req, res) {
  try {
    const { year, month } = req.query;

    if (!year || !month) {
      return errorResponse(res, 'السنة والشهر مطلوبين', 400);
    }

    const calendar = await attendanceQueries.getCalendar(year, month);
    return res.json(calendar);
  } catch (err) {
    console.error('خطأ في جلب التقويم:', err);
    return errorResponse(res, 'فشل تحميل التقويم', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getByEmployee,
  getByDate,
  getMonthlySummary,
  getBiometricLogs,
  getExemptions,
  createExemption,
  getCalendar
};