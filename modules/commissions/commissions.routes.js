const express = require('express');
const router = express.Router();
const commissionsController = require('./commissions.controller');

// ===================================
// 💎 Commissions Routes
// ===================================

// ملخص العمولات الشهري
// GET /api/commissions/summary/monthly?year=2025&month=1
router.get('/summary/monthly', commissionsController.getMonthlySummary);

// ملخص عمولات موظف
// GET /api/commissions/summary/employee/:employeeId?year=2025
router.get('/summary/employee/:employeeId', commissionsController.getEmployeeSummary);

// جلب كل العمولات
// GET /api/commissions?employeeId=xxx&year=xxx&month=xxx
router.get('/', commissionsController.getAll);

// إضافة عمولة
// POST /api/commissions
router.post('/', commissionsController.create);

// اعتماد كل عمولات شهر
// PUT /api/commissions/approve/monthly
router.put('/approve/monthly', commissionsController.approveMonthly);

// اعتماد عمولة واحدة
// PUT /api/commissions/:id/approve
router.put('/:id/approve', commissionsController.approve);

// حذف عمولة
// DELETE /api/commissions/:id
router.delete('/:id', commissionsController.remove);

// تصدير الراوتر
module.exports = router;