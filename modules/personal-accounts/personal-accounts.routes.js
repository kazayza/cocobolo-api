const express = require('express');
const router = express.Router();
const controller = require('./personal-accounts.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { personalAccounts: personalAccountsPolicy } = require('../../shared/authorization.policy');

// ===================================
// 👤 Personal Accounts Routes
// Phase 0: كانت الوحدة مفتوحة بالكامل — الآن جلسة + سياسات بمرآة بلازور.
// ===================================

router.use(authenticate);

const canView = requirePolicy(personalAccountsPolicy.canView, 'غير مصرح لك بعرض الحسابات الشخصية');
const canAdd = requirePolicy(personalAccountsPolicy.canAdd, 'غير مصرح لك بإضافة حساب شخصي أو حركة');
const canEdit = requirePolicy(personalAccountsPolicy.canEdit, 'غير مصرح لك بتعديل الحساب الشخصي');
const canDelete = requirePolicy(personalAccountsPolicy.canDelete, 'غير مصرح لك بحذف الحساب الشخصي');

// أنواع الحسابات
// GET /api/personal-accounts/types
router.get('/types', canView, controller.getTypes);

// إحصائيات كل الحسابات (دائنون/مدينون)
// GET /api/personal-accounts/totals
router.get('/totals', canView, controller.getTotals);

// قائمة الحسابات
// GET /api/personal-accounts?search=&accountType=&isActive=&balanceFilter=&page=&limit=
router.get('/', canView, controller.getAll);

// كشف حساب
// GET /api/personal-accounts/:id/statement?from=&to=
router.get('/:id/statement', canView, controller.getStatement);

// حساب واحد
// GET /api/personal-accounts/:id
router.get('/:id', canView, controller.getById);

// إنشاء حساب
// POST /api/personal-accounts
router.post('/', canAdd, controller.create);

// إضافة حركة (قرض دخل / تسديد)
// POST /api/personal-accounts/:id/transactions
router.post('/:id/transactions', canAdd, controller.createTx);

// تعديل حساب
// PUT /api/personal-accounts/:id
router.put('/:id', canEdit, controller.update);

// حذف / تعطيل حساب
// DELETE /api/personal-accounts/:id
router.delete('/:id', canDelete, controller.remove);

module.exports = router;
