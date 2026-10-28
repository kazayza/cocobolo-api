const express = require('express');
const router = express.Router();
const expensesController = require('./expenses.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { expenses: expensesPolicy } = require('../../shared/authorization.policy');

// ===================================
// 💰 Expenses Routes
// Phase 0: كانت الوحدة مفتوحة بالكامل — الآن جلسة + سياسات بمرآة ExpenseService في بلازور.
// ===================================

router.use(authenticate);

const canView = requirePolicy(expensesPolicy.canView, 'غير مصرح لك بعرض المصروفات');
const canAdd = requirePolicy(expensesPolicy.canAdd, 'غير مصرح لك بإضافة مصروف');
const canEdit = requirePolicy(expensesPolicy.canEdit, 'غير مصرح لك بتعديل مصروف');
const canDelete = requirePolicy(expensesPolicy.canDelete, 'غير مصرح لك بحذف مصروف');
const canAddGroup = requirePolicy(expensesPolicy.canAddGroup, 'غير مصرح لك بإضافة مجموعة مصروفات');

// جلب مجموعات المصروفات
// GET /api/expenses/groups
router.get('/groups', canView, expensesController.getGroups);

// إنشاء مجموعة مصروفات
// POST /api/expenses/groups
router.post('/groups', canAddGroup, expensesController.createGroup);

// جلب الخزائن
// GET /api/expenses/cashboxes
router.get('/cashboxes', canView, expensesController.getCashboxes);

// داشبورد المصروفات الكامل
// GET /api/expenses/dashboard
router.get('/dashboard', canView, expensesController.getDashboard);

// ملخص المصروفات
// GET /api/expenses/summary
router.get('/summary', canView, expensesController.getSummary);

// جلب كل المصروفات
// GET /api/expenses?search=xxx&groupId=xxx&startDate=xxx&endDate=xxx
router.get('/', canView, expensesController.getAll);

// إضافة مصروف جديد
// POST /api/expenses
router.post('/', canAdd, expensesController.create);

// تعديل مصروف
// PUT /api/expenses/:id
router.put('/:id', canEdit, expensesController.update);

// حذف مصروف
// DELETE /api/expenses/:id
router.delete('/:id', canDelete, expensesController.remove);

// جلب مجموعات المصروفات حسب المجموعة الأم
// GET /api/expenses/groups/by-parent?parentGroupName=xxx
router.get('/groups/by-parent', canView, expensesController.getGroupsByParent);

// جلب مصروف بالـ ID
router.get('/:id', canView, expensesController.getById);

// تصدير الراوتر
module.exports = router;
