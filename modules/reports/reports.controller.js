const reportsQueries = require('./reports.queries');
const { errorResponse } = require('../../shared/response.helper');

async function getDashboard(req, res) {
  try {
    const { dateFrom, dateTo, employeeId } = req.query;

    const data = await reportsQueries.getDashboardData({
      dateFrom,
      dateTo,
      employeeId
    });

    return res.json({
      success: true,
      data: data
    });
  } catch (err) {
    console.error('خطأ في جلب تقارير الداشبورد:', err);
    return errorResponse(res, 'فشل تحميل التقارير', 500, err.message);
  }
}

module.exports = {
  getDashboard
};