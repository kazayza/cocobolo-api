const express = require('express');
const router = express.Router();
const productsController = require('./products.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { products: productPolicy } = require('../../shared/authorization.policy');

// ===================================
// 📦 Products Routes
// Phase 0 (عالٍ-22): الكتابات كانت بلا مصادقة — الآن جلسة للكل وسياسات على الكتابة.
// ===================================

router.use(authenticate);

const canCreate = requirePolicy(productPolicy.canCreate, 'غير مصرح لك بإضافة منتج');
const canEdit = requirePolicy(productPolicy.canEdit, 'غير مصرح لك بتعديل المنتج');

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
router.post('/', canCreate, productsController.create);

// تعديل منتج
// PUT /api/products/:id
router.put('/:id', canEdit, productsController.update);

// إضافة صورة للمنتج
// POST /api/products/:id/images  (multipart — زي بلازور)
router.post('/:id/images', canEdit, productsController.uploadProductImage, productsController.addImage);

// حذف صورة
// DELETE /api/products/images/:id
router.delete('/images/:id', canEdit, productsController.deleteImage);

// حفظ مكونات المنتج
// POST /api/products/:id/components
router.post('/:id/components', canEdit, productsController.saveComponents);

// GET /api/products/:id/pdf
router.get('/:id/pdf', productsController.getProductPdf);

// حذف منتج - يتطلب جلسة وصلاحية حذف المنتجات
// DELETE /api/products/:id
router.delete(
  '/:id',
  authenticate,
  requirePolicy(productPolicy.canDelete, 'غير مصرح لك بحذف المنتجات'),
  productsController.remove
);

// تصدير الراوتر
module.exports = router;