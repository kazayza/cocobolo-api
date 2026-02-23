const express = require('express');
const router = express.Router();
const clientsController = require('./clients.controller');

// ===================================
// 👥 Clients Routes
// ===================================

// جلب ملخص العملاء
// GET /api/clients/summary
router.get('/summary', clientsController.getSummary);

// البحث عن عميل
// GET /api/clients/search?q=xxx
router.get('/search', clientsController.search);

// جلب قائمة العملاء (مختصرة)
// GET /api/clients/list
router.get('/list', clientsController.getList);

// جلب مصادر الإحالة
// GET /api/clients/referral-sources
router.get('/referral-sources', clientsController.getReferralSources);

// التحقق من تكرار رقم الهاتف
// GET /api/clients/check-phone?phone=xxx&phone2=xxx&excludeId=xxx
router.get('/check-phone', clientsController.checkPhone);

// جلب كل العملاء
// GET /api/clients
router.get('/', clientsController.getAll);

// جلب عميل بالـ ID
// GET /api/clients/:id
router.get('/:id', clientsController.getById);

// إضافة عميل جديد
// POST /api/clients
router.post('/', clientsController.create);

// تعديل عميل
// PUT /api/clients/:id
router.put('/:id', clientsController.update);

// حذف عميل
// DELETE /api/clients/:id
router.delete('/:id', clientsController.remove);

// تصدير الراوتر
module.exports = router;