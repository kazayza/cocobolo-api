const deliveryQueries = require('./delivery.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// ═══════════════════════════════════════════════════════════
// جلب فواتير التسليم (مع فلاتر شاملة)
// GET /api/delivery/list
//   ?status=all|overdue|today|soon|upcoming|delivered
//   &search=اسم العميل
//   &dateFrom=2026-01-01&dateTo=2026-01-31
//   &dateFilterType=due|invoice|delivered
// ═══════════════════════════════════════════════════════════
async function getDeliveries(req, res) {
  try {
    const { status, search, dateFrom, dateTo, dateFilterType } = req.query;

    const deliveries = await deliveryQueries.getDeliveries({
      status: status || 'all',
      search: search || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      dateFilterType: dateFilterType || 'due',
    });

    return successResponse(res, deliveries, 'تم جلب التسليمات بنجاح');
  } catch (err) {
    console.error('❌ getDeliveries:', err.message);
    return errorResponse(res, 'فشل تحميل التسليمات', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// إحصائيات شاملة (مع نفس الفلاتر)
// GET /api/delivery/stats
// ═══════════════════════════════════════════════════════════
async function getDeliveryStats(req, res) {
  try {
    const { search, dateFrom, dateTo, dateFilterType } = req.query;

    const stats = await deliveryQueries.getDeliveryStats({
      search: search || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      dateFilterType: dateFilterType || 'due',
    });

    return res.json(stats);
  } catch (err) {
    console.error('❌ getDeliveryStats:', err.message);
    return errorResponse(res, 'فشل تحميل الإحصائيات', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// تفاصيل فاتورة تسليم كاملة
// GET /api/delivery/:id
// ═══════════════════════════════════════════════════════════
async function getDeliveryDetails(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const details = await deliveryQueries.getDeliveryDetails(id);
    if (!details) return notFoundResponse(res, 'الفاتورة غير موجودة');

    return successResponse(res, details, 'تم جلب التفاصيل بنجاح');
  } catch (err) {
    console.error('❌ getDeliveryDetails:', err.message);
    return errorResponse(res, 'فشل تحميل التفاصيل', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// تحديث حالة التسليم
// PUT /api/delivery/:id/deliver
// Body: { deliveryEmployeeName?, deliveredNotes? }
// ═══════════════════════════════════════════════════════════
async function markAsDelivered(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const { deliveryEmployeeName, deliveredNotes } = req.body || {};

    await deliveryQueries.markAsDelivered({
      transactionId: id,
      deliveryEmployeeName,
      deliveredNotes,
    });

    return successResponse(res, null, 'تم تأكيد التسليم بنجاح');
  } catch (err) {
    console.error('❌ markAsDelivered:', err.message);
    return errorResponse(res, 'فشل تحديث التسليم', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// الفواتير القريبة (للإشعارات)
// GET /api/delivery/upcoming
// ═══════════════════════════════════════════════════════════
async function getUpcomingDeliveries(req, res) {
  try {
    const deliveries = await deliveryQueries.getUpcomingDeliveries();
    return res.json(deliveries);
  } catch (err) {
    console.error('❌ getUpcomingDeliveries:', err.message);
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

module.exports = {
  getDeliveries,
  getDeliveryStats,
  getDeliveryDetails,
  markAsDelivered,
  getUpcomingDeliveries,
};
