const express = require('express');
const router = express.Router();
const payrollController = require('./payroll.controller');

// ===================================
// 💵 Payroll Routes
// ===================================

// جلب مرتبات شهر معين
// GET /api/payroll?month=2025-01
router.get('/', payrollController.getByMonth);

// جلب مرتبات موظف
// GET /api/payroll/employee/:employeeId
router.get('/employee/:employeeId', payrollController.getByEmployee);

// جلب مرتب بالـ ID
// GET /api/payroll/:id
router.get('/:id', payrollController.getById);

// إنشاء مرتب جديد
// POST /api/payroll
router.post('/', payrollController.create);

// تعديل مرتب
// PUT /api/payroll/:id
router.put('/:id', payrollController.update);

// تحديث حالة الدفع
// PUT /api/payroll/:id/status
router.put('/:id/status', payrollController.updateStatus);

// إضافة تفصيل للمرتب
// POST /api/payroll/:id/details
router.post('/:id/details', payrollController.addDetail);

// حذف تفصيل
// DELETE /api/payroll/details/:detailId
router.delete('/details/:detailId', payrollController.deleteDetail);

// تصدير الراوتر
module.exports = router;