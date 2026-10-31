const reportsQueries = require('./reports.queries');
const salesAnalyticsQueries = require('./sales-analytics.queries');
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

// تحليلات المبيعات (بند 23) — مرآة SalesAnalyticsService.cs
async function getSalesAnalytics(req, res) {
  try {
    const filter = salesAnalyticsQueries.parseFilter(req.query);
    const data = await salesAnalyticsQueries.withPool(
      (pool) => salesAnalyticsQueries.getSalesAnalytics(pool, filter, req.auth),
    );
    return res.json({ success: true, data, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('❌ Sales Analytics Error:', err);
    return errorResponse(
      res,
      err.statusCode === 400 ? err.message : 'فشل تحميل تحليلات المبيعات',
      err.statusCode || 500,
      err.code || err.message,
    );
  }
}

async function getSalesAnalyticsFilters(req, res) {
  try {
    const data = await salesAnalyticsQueries.withPool(
      (pool) => salesAnalyticsQueries.getFilterData(pool),
    );
    return res.json({ success: true, data, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('❌ Sales Analytics Filters Error:', err);
    return errorResponse(res, 'فشل تحميل بيانات الفلاتر', 500, err.message);
  }
}

module.exports = { getDashboard, getSalesAnalytics, getSalesAnalyticsFilters };