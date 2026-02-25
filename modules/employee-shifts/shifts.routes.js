const express = require('express');
const router = express.Router();
const shiftsController = require('./shifts.controller');

// ===================================
// 📅 Employee Shifts Routes
// ===================================

router.get('/status', shiftsController.getEmployeesShiftsStatus);

router.get('/search', shiftsController.search);

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