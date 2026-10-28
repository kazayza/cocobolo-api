const express = require('express');
const router = express.Router();
const shiftsController = require('./shifts.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
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
router.post('/', shiftsController.create);

// حذف شيفت
// DELETE /api/shifts/:id
router.delete('/:id', shiftsController.remove);

module.exports = router;