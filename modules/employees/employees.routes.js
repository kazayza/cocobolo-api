const express = require('express');
const router = express.Router();
const employeesController = require('./employees.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// ===================================
// 👨‍💼 Employees Routes
// ===================================

// جلب القوائم (الأقسام والوظائف)
// GET /api/employees/lookups
router.get('/lookups', employeesController.getLookups);

// جلب الموظفين النشطين
// GET /api/employees/active
router.get('/active', employeesController.getActive);

// جلب كل الموظفين
// GET /api/employees
router.get('/', employeesController.getAll);

// جلب موظف بالـ ID
// GET /api/employees/:id
router.get('/:id', employeesController.getById);

// جلب سجل رواتب الموظف
// GET /api/employees/:id/salary-history
router.get('/:id/salary-history', employeesController.getSalaryHistory);

// إضافة موظف جديد
// POST /api/employees
router.post('/', employeesController.create);

// تعديل موظف
// PUT /api/employees/:id
router.put('/:id', employeesController.update);

// تغيير حالة الموظف
// PUT /api/employees/:id/status
router.put('/:id/status', employeesController.updateStatus);

// تصدير الراوتر
module.exports = router;