const express = require('express');
const router = express.Router();
const shiftsController = require('./shifts.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const policies = require('../../shared/authorization.policy');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
// مرحلة صفر الموارد: تعديلات الورديات خلف بوابة أدوار/Claims مطابقة
// لبلازور (frm_EmpolyeeShifts)؛ القراءات لأي جلسة، وجدول الغير للمديرين.
const canCreateShift = requirePolicy(policies.shifts.canCreate, 'غير مصرح لك بإضافة وردية');
const canEditShift = requirePolicy(policies.shifts.canEdit, 'غير مصرح لك بتعديل وردية');
const canDeleteShift = requirePolicy(policies.shifts.canDelete, 'غير مصرح لك بحذف وردية');
router.use(authenticate);

// ===================================
// 📅 Employee Shifts Routes
// ===================================

router.get('/status', shiftsController.getEmployeesShiftsStatus);

router.get('/search', shiftsController.search);

// جلب جدول الموظف (للتقويم)
// GET /api/shifts/my-schedule/:userId?year=2025&month=2
router.get('/my-schedule/:userId', shiftsController.getMySchedule);

// جلب شيفتات موظف
// GET /api/shifts/employee/:id
router.get('/employee/:id', shiftsController.getByEmployee);

// إضافة شيفت جديد
// POST /api/shifts
router.post('/', canCreateShift, shiftsController.create);

// تعديل شيفت قائم في مكانه (لا يكرّره)
// PUT /api/shifts/:id
router.put('/:id', canEditShift, shiftsController.update);

// حذف شيفت
// DELETE /api/shifts/:id
router.delete('/:id', canDeleteShift, shiftsController.remove);

module.exports = router;