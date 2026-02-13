const reportsQueries = require('./reports.queries');
const { errorResponse } = require('../../shared/response.helper');

async function getDashboard(req, res) {
  try {
    const { dateFrom, dateTo, employeeId, sourceId, stageId, adTypeId } = req.query;

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
      employeeId: employeeId || null,
      sourceId: sourceId || null,
      stageId: stageId || null,
      adTypeId: adTypeId || null,
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

module.exports = { getDashboard };