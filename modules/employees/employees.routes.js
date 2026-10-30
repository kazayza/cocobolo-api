const express = require('express');
const router = express.Router();
const employeesController = require('./employees.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const policies = require('../../shared/authorization.policy');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
// مرحلة صفر الموارد: الكتابات (إنشاء/تعديل/حالة) خلف بوابة أدوار/Claims
// مطابقة لبلازور (frm_Employees)؛ القراءات تبقى لأي جلسة مصادقة.
const canCreateEmployee = requirePolicy(policies.employees.canCreate, 'غير مصرح لك بإضافة موظف');
const canEditEmployee = requirePolicy(policies.employees.canEdit, 'غير مصرح لك بتعديل بيانات موظف');
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
router.post('/', canCreateEmployee, employeesController.create);

// تعديل موظف
// PUT /api/employees/:id
router.put('/:id', canEditEmployee, employeesController.update);

// تغيير حالة الموظف
// PUT /api/employees/:id/status
router.put('/:id/status', canEditEmployee, employeesController.updateStatus);

// تصدير الراوتر
module.exports = router;