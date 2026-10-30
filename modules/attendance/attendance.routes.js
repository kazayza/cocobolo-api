const express = require('express');
const router = express.Router();
const attendanceController = require('./attendance.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// ===================================
// ⏰ Attendance Routes
// ===================================

// ✅ تسجيل الحضور والانصراف (جديد)
router.post('/check-in', attendanceController.checkIn);
router.post('/check-out', attendanceController.checkOut);
router.get('/status/:userId', attendanceController.getStatus);
router.get('/statistics/:userId', attendanceController.getStatistics); 
router.get('/report', attendanceController.getReport); 

// التقارير (قديم)
router.get('/summary', attendanceController.getMonthlySummary);
router.get('/calendar', attendanceController.getCalendar);
router.get('/by-date', attendanceController.getByDate);
// عرض الاستثناءات
// GET /api/attendance/exemptions-list
router.get('/exemptions-list', attendanceController.getExemptionsList);
router.get('/employee/:biometricCode', attendanceController.getByEmployee);
router.get('/biometric/:biometricCode', attendanceController.getBiometricLogs);
router.get('/exemptions/:biometricCode', attendanceController.getExemptions);

router.post('/exemptions', attendanceController.createExemption);
// اعتماد / رفض استثناء (مديرو الإعفاءات فقط — الحارس داخل المتحكم)
// POST /api/attendance/exemptions/:id/approve | /reject
router.post('/exemptions/:id/approve', attendanceController.approveExemption);
router.post('/exemptions/:id/reject', attendanceController.rejectExemption);
// حذف استثناء
// DELETE /api/attendance/exemptions/:id
router.delete('/exemptions/:id', attendanceController.removeExemption);

// الحضور اليدوي للمعفيين من البصمة
// GET /api/attendance/manual?month=YYYY-MM
router.get('/manual', attendanceController.getManualAttendance);
// POST /api/attendance/manual (بوابة كتابة داخل المتحكم)
router.post('/manual', attendanceController.saveManualAttendance);

// سجلات البصمة الخام
// GET /api/attendance/raw-logs
router.get('/raw-logs', attendanceController.getRawLogs);
// الحضور اليدوي اليومي
router.get('/manual-daily/record', attendanceController.getManualRecord);
router.get('/manual-daily/day', attendanceController.getManualDay);
router.post('/manual-daily', attendanceController.createManualDaily);
router.put('/manual-daily/:id', attendanceController.updateManualDaily);
router.delete('/manual-daily/:id', attendanceController.deleteManualDaily);

module.exports = router;