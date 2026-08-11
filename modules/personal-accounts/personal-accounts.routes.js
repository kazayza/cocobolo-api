const express = require('express');
const router = express.Router();
const controller = require('./personal-accounts.controller');

// ===================================
// 👤 Personal Accounts Routes
// ===================================

// أنواع الحسابات
// GET /api/personal-accounts/types
router.get('/types', controller.getTypes);

// إحصائيات كل الحسابات (دائنون/مدينون)
// GET /api/personal-accounts/totals
router.get('/totals', controller.getTotals);

// قائمة الحسابات
// GET /api/personal-accounts?search=&accountType=&isActive=&balanceFilter=&page=&limit=
router.get('/', controller.getAll);

// كشف حساب
// GET /api/personal-accounts/:id/statement?from=&to=
router.get('/:id/statement', controller.getStatement);

// حساب واحد
// GET /api/personal-accounts/:id
router.get('/:id', controller.getById);

// إنشاء حساب
// POST /api/personal-accounts
router.post('/', controller.create);

// إضافة حركة (قرض دخل / تسديد)
// POST /api/personal-accounts/:id/transactions
router.post('/:id/transactions', controller.createTx);

// تعديل حساب
// PUT /api/personal-accounts/:id
router.put('/:id', controller.update);

// حذف / تعطيل حساب
// DELETE /api/personal-accounts/:id
router.delete('/:id', controller.remove);

module.exports = router;
