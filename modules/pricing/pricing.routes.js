const express = require('express');
const router = express.Router();
const pricingController = require('./pricing.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { priceList: priceListPolicy } = require('../../shared/authorization.policy');

// =============================================
// 💰 Pricing Routes
// =============================================

// -----------------------------------------------
// قائمة الأسعار - الكتالوج العام للموبايل
// -----------------------------------------------
router.get(
  '/price-list',
  authenticate,
  requirePolicy(priceListPolicy.canView, 'غير مصرح لك بعرض قائمة الأسعار'),
  pricingController.getPriceList,
);
router.get(
  '/price-list/:id/history',
  authenticate,
  requirePolicy(priceListPolicy.canViewHistory, 'غير مصرح لك بعرض سجل الأسعار'),
  pricingController.getPriceListHistory,
);
router.get(
  '/price-list/:id/images',
  authenticate,
  requirePolicy(priceListPolicy.canView, 'غير مصرح لك بعرض صور المنتج'),
  pricingController.getPriceListImages,
);
router.put(
  '/price-list/:id/price',
  authenticate,
  requirePolicy(priceListPolicy.canEditSalePrice, 'التعديل المباشر متاح للمدير ومدير الحسابات فقط'),
  pricingController.updatePriceListPrice,
);
router.put(
  '/price-list/:id/cost',
  authenticate,
  requirePolicy(priceListPolicy.canEditCost, 'تعديل التكلفة غير متاح لهذا المستخدم'),
  pricingController.updatePriceListCost,
);
router.post(
  '/price-list/:id/request',
  authenticate,
  requirePolicy(priceListPolicy.canRequestPriceChange, 'غير مصرح لك بطلب تعديل السعر'),
  pricingController.requestPriceListChange,
);

// -----------------------------------------------
// 🔢 نسب الربح (Admin / AccountManager فقط)
// -----------------------------------------------

// جلب النسب الحالية
// GET /api/pricing/margins
// Phase 0 (عالٍ-15): كانت بلا مصادقة — النسب والتكلفة بيانات حساسة.
router.get(
  '/margins',
  authenticate,
  requirePolicy(priceListPolicy.canViewHistory, 'غير مصرح لك بعرض نسب الربح'),
  pricingController.getActiveMargins,
);

// جلب سجل تغييرات النسب
// GET /api/pricing/margins/history
router.get(
  '/margins/history',
  authenticate,
  requirePolicy(priceListPolicy.canViewHistory, 'غير مصرح لك بعرض سجل نسب الربح'),
  pricingController.getMarginsHistory,
);

// تحديث النسب
// PUT /api/pricing/margins
router.put(
  '/margins',
  authenticate,
  requirePolicy(priceListPolicy.canEditSalePrice, 'تعديل نسب الربح متاح للمدير ومدير الحسابات فقط'),
  pricingController.updateMargins,
);

// -----------------------------------------------
// 💰 تسعير المنتج (Factory فقط)
// -----------------------------------------------

// تسعير منتج (تكلفة فقط)
// PUT /api/pricing/products/:id/cost
router.put(
  '/products/:id/cost',
  authenticate,
  requirePolicy(priceListPolicy.canEditCost, 'تعديل التكلفة غير متاح لهذا المستخدم'),
  pricingController.updateProductPricing,
);

// -----------------------------------------------
// 💵 تعديل سعر البيع (Admin / AccountManager فقط)
// -----------------------------------------------

// تعديل سعر البيع مباشرة
// PUT /api/pricing/products/:id/sale-price
router.put(
  '/products/:id/sale-price',
  authenticate,
  requirePolicy(priceListPolicy.canEditSalePrice, 'التعديل المباشر متاح للمدير ومدير الحسابات فقط'),
  pricingController.updateSalePrice,
);

// -----------------------------------------------
// 📝 طلبات تعديل الأسعار
// -----------------------------------------------

// إنشاء طلب تعديل (Sales)
// POST /api/pricing/products/:id/price-request
router.post(
  '/products/:id/price-request',
  authenticate,
  requirePolicy(priceListPolicy.canRequestPriceChange, 'غير مصرح لك بطلب تعديل السعر'),
  pricingController.createPriceRequest,
);

// جلب الطلبات المعلقة (SalesManager)
// GET /api/pricing/price-requests/pending
router.get(
  '/price-requests/pending',
  authenticate,
  requirePolicy(priceListPolicy.canReviewRequests, 'غير مصرح لك بمراجعة طلبات الأسعار'),
  pricingController.getPendingRequests,
);

// جلب طلباتي (Sales)
// GET /api/pricing/price-requests/my?username=xxx
router.get('/price-requests/my', authenticate, pricingController.getMyRequests);

// جلب كل الطلبات (Admin)
// GET /api/pricing/price-requests/all
router.get(
  '/price-requests/all',
  authenticate,
  requirePolicy(priceListPolicy.canReviewRequests, 'غير مصرح لك بعرض كل طلبات الأسعار'),
  pricingController.getAllRequests,
);

// موافقة على طلب (SalesManager)
// PUT /api/pricing/price-requests/:id/approve
router.put(
  '/price-requests/:id/approve',
  authenticate,
  requirePolicy(priceListPolicy.canReviewRequests, 'غير مصرح لك بالموافقة على طلبات الأسعار'),
  pricingController.approveRequest,
);

// رفض طلب (SalesManager)
// PUT /api/pricing/price-requests/:id/reject
router.put(
  '/price-requests/:id/reject',
  authenticate,
  requirePolicy(priceListPolicy.canReviewRequests, 'غير مصرح لك برفض طلبات الأسعار'),
  pricingController.rejectRequest,
);

// -----------------------------------------------
// 📊 تاريخ الأسعار
// -----------------------------------------------

// جلب تاريخ أسعار منتج
// GET /api/pricing/products/:id/history
router.get(
  '/products/:id/history',
  authenticate,
  requirePolicy(priceListPolicy.canView, 'غير مصرح لك بعرض تاريخ أسعار المنتج'),
  pricingController.getPriceHistory,
);

// تصدير الراوتر
module.exports = router;