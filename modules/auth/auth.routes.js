const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const { authenticate } = require('../../core/auth.middleware');

// ===================================
// 🔐 Auth Routes
// ===================================

// تسجيل الدخول
// POST /api/auth/login
router.post('/login', authController.login);

// استعادة بيانات الجلسة والصلاحيات الحالية
router.get('/me', authenticate, authController.me);

// حفظ FCM Token للمستخدم الحالي
router.post('/save-token', authenticate, authController.saveFcmToken);

// جلب بيانات الموظف المرتبط بالمستخدم
// GET /api/auth/users/:userId/employee
router.get('/users/:userId/employee', authController.getEmployeeByUserId);

router.post('/change-password', authController.changePassword);

// تصدير الراوتر
module.exports = router;