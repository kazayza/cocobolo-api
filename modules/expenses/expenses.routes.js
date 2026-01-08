const express = require('express');
const router = express.Router();
const expensesController = require('./expenses.controller');

// ===================================
// 💰 Expenses Routes
// ===================================

// جلب مجموعات المصروفات
// GET /api/expenses/groups
router.get('/groups', expensesController.getGroups);

// جلب الخزائن
// GET /api/expenses/cashboxes
router.get('/cashboxes', expensesController.getCashboxes);

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

// تصدير الراوتر
module.exports = router;