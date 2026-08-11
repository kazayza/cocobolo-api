const express = require('express');
const router = express.Router();
const productsController = require('./products.controller');

// ===================================
// 📦 Products Routes
// ===================================

// جلب مجموعات المنتجات
// GET /api/products/groups
router.get('/groups', productsController.getGroups);

// إحصائيات المنتجات
// GET /api/products/stats
router.get('/stats', productsController.getStats);

// حالات التسعير (للفلتر)
// GET /api/products/pricing-statuses
router.get('/pricing-statuses', productsController.getPricingStatuses);

// جلب كل المنتجات
// GET /api/products?search=xxx&groupId=xxx&statusId=xxx&ownership=all|showroom|linked&priced=all|priced|unpriced
router.get('/', productsController.getAll);

// جلب منتج بالـ ID
// GET /api/products/:id
router.get('/:id', productsController.getById);

// إضافة منتج جديد
// POST /api/products
router.post('/', productsController.create);

// تعديل منتج
// PUT /api/products/:id
router.put('/:id', productsController.update);

// إضافة صورة للمنتج
// POST /api/products/:id/images
router.post('/:id/images', productsController.addImage);

// حذف صورة
// DELETE /api/products/images/:id
router.delete('/images/:id', productsController.deleteImage);

// حفظ مكونات المنتج
// POST /api/products/:id/components
router.post('/:id/components', productsController.saveComponents);

// GET /api/products/:id/pdf
router.get('/:id/pdf', productsController.getProductPdf);

// تصدير الراوتر
module.exports = router;