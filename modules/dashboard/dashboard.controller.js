const dashboardQueries = require('./dashboard.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب إحصائيات لوحة التحكم
async function getStats(req, res) {
  try {
    const { userId, username } = req.query;

    const stats = await dashboardQueries.getDashboardStats(userId, username);

    return res.json({
      summary: stats,
      unreadCount: stats?.unreadCount || 0
    });
  } catch (err) {
    console.error('خطأ في الداشبورد:', err);
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

// جلب النشاطات الأخيرة
async function getRecentActivities(req, res) {
  try {
    const activities = await dashboardQueries.getRecentActivities();

    return res.json({
      success: true,
      count: activities.length,
      activities: activities
    });
  } catch (err) {
    console.error('خطأ في جلب النشاطات:', err);
    return errorResponse(res, 'فشل تحميل النشاطات', 500, err.message);
  }
}

// جلب بيانات التشخيص
async function getDebug(req, res) {
  try {
    const results = await dashboardQueries.getDebugData();

    return res.json({
      success: true,
      message: 'نتائج التشخيص',
      results: results
    });
  } catch (err) {
    console.error('خطأ في التشخيص:', err);
    return errorResponse(res, 'فشل التشخيص', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getStats,
  getRecentActivities,
  getDebug
};