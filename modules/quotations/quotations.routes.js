const express = require('express');
const router = express.Router();
const quotationsController = require('./quotations.controller');

// ===================================
// 📋 Quotations Routes
// ===================================

// جلب كل عروض الأسعار
// GET /api/quotations?startDate=xxx&endDate=xxx&partyId=xxx
router.get('/', quotationsController.getAll);

// جلب عرض سعر بالـ ID
// GET /api/quotations/:id
router.get('/:id', quotationsController.getById);

// إنشاء عرض سعر جديد
// POST /api/quotations
router.post('/', quotationsController.create);

// تحويل عرض سعر لفاتورة
// PUT /api/quotations/:id/convert
router.put('/:id/convert', quotationsController.convertToInvoice);

// حذف عرض سعر
// DELETE /api/quotations/:id
router.delete('/:id', quotationsController.remove);

// تصدير الراوتر
module.exports = router;