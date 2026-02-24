const express = require('express');
const router = express.Router();
const attendanceController = require('./attendance.controller');

// ===================================
// ⏰ Attendance Routes
// ===================================

// ✅ تسجيل الحضور والانصراف (جديد)
router.post('/check-in', attendanceController.checkIn);
router.post('/check-out', attendanceController.checkOut);
router.get('/status/:userId', attendanceController.getStatus);

// التقارير (قديم)
router.get('/summary', attendanceController.getMonthlySummary);
router.get('/calendar', attendanceController.getCalendar);
router.get('/by-date', attendanceController.getByDate);
router.get('/employee/:biometricCode', attendanceController.getByEmployee);
router.get('/biometric/:biometricCode', attendanceController.getBiometricLogs);
router.get('/exemptions/:biometricCode', attendanceController.getExemptions);
router.post('/exemptions', attendanceController.createExemption);

module.exports = router;