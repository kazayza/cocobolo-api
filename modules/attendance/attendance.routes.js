const express = require('express');
const router = express.Router();
const attendanceController = require('./attendance.controller');

// ===================================
// ⏰ Attendance Routes
// ===================================

// جلب ملخص الحضور الشهري
// GET /api/attendance/summary?year=2025&month=1
router.get('/summary', attendanceController.getMonthlySummary);

// جلب التقويم
// GET /api/attendance/calendar?year=2025&month=1
router.get('/calendar', attendanceController.getCalendar);

// جلب الحضور لتاريخ معين
// GET /api/attendance/by-date?date=2025-01-15
router.get('/by-date', attendanceController.getByDate);

// جلب الحضور لموظف معين
// GET /api/attendance/employee/:biometricCode?startDate=xxx&endDate=xxx
router.get('/employee/:biometricCode', attendanceController.getByEmployee);

// جلب سجلات البصمة
// GET /api/attendance/biometric/:biometricCode?date=2025-01-15
router.get('/biometric/:biometricCode', attendanceController.getBiometricLogs);

// جلب الإعفاءات لموظف
// GET /api/attendance/exemptions/:biometricCode?startDate=xxx&endDate=xxx
router.get('/exemptions/:biometricCode', attendanceController.getExemptions);

// إضافة إعفاء
// POST /api/attendance/exemptions
router.post('/exemptions', attendanceController.createExemption);

// تصدير الراوتر
module.exports = router;