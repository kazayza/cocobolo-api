const deliveryQueries = require('./delivery.queries');
const { errorResponse } = require('../../shared/response.helper');

// جلب الفواتير المعلقة
async function getPendingDeliveries(req, res) {
  try {
    const { status } = req.query;
    const deliveries = await deliveryQueries.getPendingDeliveries(status);
    return res.json(deliveries);
  } catch (err) {
    console.error('خطأ في جلب التسليمات:', err);
    return errorResponse(res, 'فشل تحميل التسليمات', 500, err.message);
  }
}

// تحديث حالة التسليم
async function markAsDelivered(req, res) {
  try {
    const { id } = req.params;

    await deliveryQueries.markAsDelivered(id);

    return res.json({
      success: true,
      message: 'تم تحديث حالة التسليم بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تحديث التسليم:', err);
    return errorResponse(res, 'فشل تحديث التسليم', 500, err.message);
  }
}

// إحصائيات التسليم
async function getDeliveryStats(req, res) {
  try {
    const stats = await deliveryQueries.getDeliveryStats();
    return res.json(stats);
  } catch (err) {
    console.error('خطأ في جلب الإحصائيات:', err);
    return errorResponse(res, 'فشل تحميل الإحصائيات', 500, err.message);
  }
}

module.exports = {
  getPendingDeliveries,
  markAsDelivered,
  getDeliveryStats
};