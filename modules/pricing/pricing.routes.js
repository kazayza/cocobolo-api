const express = require('express');
const router = express.Router();
const pricingController = require('./pricing.controller');

// =============================================
// 💰 Pricing Routes
// =============================================

// -----------------------------------------------
// 🔢 نسب الربح (Admin / AccountManager فقط)
// -----------------------------------------------

// جلب النسب الحالية
// GET /api/pricing/margins
router.get('/margins', pricingController.getActiveMargins);

// جلب سجل تغييرات النسب
// GET /api/pricing/margins/history
router.get('/margins/history', pricingController.getMarginsHistory);

// تحديث النسب
// PUT /api/pricing/margins
router.put('/margins', pricingController.updateMargins);

// -----------------------------------------------
// 💰 تسعير المنتج (Factory فقط)
// -----------------------------------------------

// تسعير منتج (تكلفة فقط)
// PUT /api/pricing/products/:id/cost
router.put('/products/:id/cost', pricingController.updateProductPricing);

// -----------------------------------------------
// 💵 تعديل سعر البيع (Admin / AccountManager فقط)
// -----------------------------------------------

// تعديل سعر البيع مباشرة
// PUT /api/pricing/products/:id/sale-price
router.put('/products/:id/sale-price', pricingController.updateSalePrice);

// -----------------------------------------------
// 📝 طلبات تعديل الأسعار
// -----------------------------------------------

// إنشاء طلب تعديل (Sales)
// POST /api/pricing/products/:id/price-request
router.post('/products/:id/price-request', pricingController.createPriceRequest);

// جلب الطلبات المعلقة (SalesManager)
// GET /api/pricing/price-requests/pending
router.get('/price-requests/pending', pricingController.getPendingRequests);

// جلب طلباتي (Sales)
// GET /api/pricing/price-requests/my?username=xxx
router.get('/price-requests/my', pricingController.getMyRequests);

// جلب كل الطلبات (Admin)
// GET /api/pricing/price-requests/all
router.get('/price-requests/all', pricingController.getAllRequests);

// موافقة على طلب (SalesManager)
// PUT /api/pricing/price-requests/:id/approve
router.put('/price-requests/:id/approve', pricingController.approveRequest);

// رفض طلب (SalesManager)
// PUT /api/pricing/price-requests/:id/reject
router.put('/price-requests/:id/reject', pricingController.rejectRequest);

// -----------------------------------------------
// 📊 تاريخ الأسعار
// -----------------------------------------------

// جلب تاريخ أسعار منتج
// GET /api/pricing/products/:id/history
router.get('/products/:id/history', pricingController.getPriceHistory);

// تصدير الراوتر
module.exports = router;