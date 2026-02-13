// reports.controller.js
const reportsQueries = require('./reports.queries');
const { errorResponse } = require('../../shared/response.helper');

// ===================================================
// 🔹 Dashboard الرئيسي
// ===================================================
async function getDashboard(req, res) {
  try {
    const { dateFrom, dateTo, employeeId } = req.query;

    // Validation
    if (dateFrom && isNaN(Date.parse(dateFrom))) {
      return errorResponse(res, 'تاريخ البداية غير صالح', 400);
    }
    if (dateTo && isNaN(Date.parse(dateTo))) {
      return errorResponse(res, 'تاريخ النهاية غير صالح', 400);
    }

    const data = await reportsQueries.getDashboardData({
      dateFrom,
      dateTo,
      employeeId: employeeId ? parseInt(employeeId) : null,
    });

    return res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ Dashboard Error:', err);
    return errorResponse(res, 'فشل تحميل لوحة القيادة', 500, err.message);
  }
}

// ===================================================
// 🔹 قائمة الموظفين (للفلتر في الـ Dropdown)
// ===================================================
async function getEmployees(req, res) {
  try {
    const { connectDB } = require('../../core/database');
    const pool = await connectDB();
    const employees = await reportsQueries.getSalesEmployees(pool);

    return res.json({
      success: true,
      data: employees,
    });
  } catch (err) {
    console.error('❌ Employees Error:', err);
    return errorResponse(res, 'فشل تحميل قائمة الموظفين', 500, err.message);
  }
}

module.exports = {
  getDashboard,
  getEmployees,
};