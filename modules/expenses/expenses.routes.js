const express = require('express');
const router = express.Router();
const expensesController = require('./expenses.controller');

// ===================================
// 💰 Expenses Routes
// ===================================

// جلب مجموعات المصروفات
// GET /api/expenses/groups
router.get('/groups', expensesController.getGroups);

// إنشاء مجموعة مصروفات
// POST /api/expenses/groups
router.post('/groups', expensesController.createGroup);

// جلب الخزائن
// GET /api/expenses/cashboxes
router.get('/cashboxes', expensesController.getCashboxes);

// داشبورد المصروفات الكامل
// GET /api/expenses/dashboard
router.get('/dashboard', expensesController.getDashboard);

// ملخص المصروفات
// GET /api/expenses/summary
router.get('/summary', expensesController.getSummary);

// جلب كل المصروفات
// GET /api/expenses?search=xxx&groupId=xxx&startDate=xxx&endDate=xxx
router.get('/', expensesController.getAll);

// إضافة مصروف جديد
// POST /api/expenses
router.post('/', expensesController.create);

// تعديل مصروف
// PUT /api/expenses/:id
router.put('/:id', expensesController.update);

// حذف مصروف
// DELETE /api/expenses/:id
router.delete('/:id', expensesController.remove);

// جلب مجموعات المصروفات حسب المجموعة الأم
// GET /api/expenses/groups/by-parent?parentGroupName=xxx
router.get('/groups/by-parent', expensesController.getGroupsByParent);

// جلب مصروف بالـ ID
router.get('/:id', expensesController.getById);

// تصدير الراوتر
module.exports = router;