const express = require('express');
const router = express.Router();
const quotationsController = require('./quotations.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { quotations: quotationPolicy } = require('../../shared/authorization.policy');
const { validateShareToken } = require('../../shared/share-token');

// Public customer view and response — Phase 0 (حرج-5):
// أُغلقت الروابط بالرقم الخام نهائيًا كما في بلازور. المسار العام الوحيد الآن
// بتوكن موقّع مطابق لآلية بلازور (HMAC-SHA256، السر في SHARE_SECRET بنفس قيمة
// Security:ShareSecret عند بلازور). التوكن الصالح يُترجم إلى req.params.id
// فتعمل المعالجات القديمة كما هي دون تغيير سلوكها أو قواعد حالاتها.
function resolvePublicQuotation(req, res, next) {
  const payload = validateShareToken(req.params.token);
  if (!payload || payload.type !== 'quotation') {
    console.warn(`[public-quotation] rejected token for path ${req.originalUrl}`);
    return res.status(404).json({ success: false, message: 'عرض السعر غير موجود' });
  }
  req.params.id = String(payload.id);
  return next();
}

router.get('/public/:token', resolvePublicQuotation, quotationsController.getPublic);
router.post('/public/:token/respond', resolvePublicQuotation, quotationsController.publicRespond);

// Lookups must remain before /:id.
router.get(
  '/lookups/form',
  authenticate,
  requirePolicy(quotationPolicy.canView, 'غير مصرح لك بعرض عروض الأسعار'),
  quotationsController.getLookups,
);
router.get(
  '/lookups/products',
  authenticate,
  requirePolicy(quotationPolicy.canView, 'غير مصرح لك بعرض منتجات عرض السعر'),
  quotationsController.getProducts,
);
router.get(
  '/products/:productId/alternatives',
  authenticate,
  requirePolicy(quotationPolicy.canView, 'غير مصرح لك بعرض بدائل المنتج'),
  quotationsController.getAlternatives,
);

router.get(
  '/',
  authenticate,
  requirePolicy(quotationPolicy.canView, 'غير مصرح لك بعرض عروض الأسعار'),
  quotationsController.getAll,
);
router.post(
  '/',
  authenticate,
  requirePolicy(quotationPolicy.canAdd, 'غير مصرح لك بإنشاء عرض سعر'),
  quotationsController.create,
);
router.get(
  '/:id',
  authenticate,
  requirePolicy(quotationPolicy.canView, 'غير مصرح لك بعرض عرض السعر'),
  quotationsController.getById,
);
router.put(
  '/:id',
  authenticate,
  requirePolicy(quotationPolicy.canEdit, 'غير مصرح لك بتعديل عرض السعر'),
  quotationsController.update,
);
router.put(
  '/:id/status',
  authenticate,
  requirePolicy(quotationPolicy.canEdit, 'غير مصرح لك بتغيير حالة عرض السعر'),
  quotationsController.changeStatus,
);
router.delete(
  '/:id',
  authenticate,
  requirePolicy(quotationPolicy.canDelete, 'غير مصرح لك بحذف عرض السعر'),
  quotationsController.remove,
);
router.put(
  '/:id/costs',
  authenticate,
  requirePolicy(quotationPolicy.canEditCost, 'تعديل التكاليف متاح لدور المصنع فقط'),
  quotationsController.saveCosts,
);
router.post(
  '/:id/request-pricing',
  authenticate,
  requirePolicy(
    (auth) => quotationPolicy.canView(auth) && !quotationPolicy.isCostOnlyViewer(auth),
    'طلب التسعير متاح لفريق المبيعات فقط',
  ),
  quotationsController.requestPricing,
);
router.post(
  '/:id/request-discount',
  authenticate,
  requirePolicy(
    (auth) => quotationPolicy.canAdd(auth) || quotationPolicy.canEdit(auth),
    'غير مصرح لك بطلب خصم',
  ),
  quotationsController.requestDiscount,
);
router.post(
  '/:id/convert',
  authenticate,
  requirePolicy(quotationPolicy.canConvert, 'غير مصرح لك بتحويل العرض إلى فاتورة'),
  quotationsController.convertToInvoice,
);

module.exports = router;
