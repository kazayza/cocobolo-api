const express = require('express');
const router = express.Router();
const quotationsController = require('./quotations.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { quotations: quotationPolicy } = require('../../shared/authorization.policy');

// Public customer view and response.
router.get('/public/:id', quotationsController.getPublic);
router.post('/public/:id/respond', quotationsController.publicRespond);

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
