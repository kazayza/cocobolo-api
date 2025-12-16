const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');

// ===================================
// 🔐 Auth Routes
// ===================================

// تسجيل الدخول
// POST /api/auth/login
router.post('/login', authController.login);

// حفظ FCM Token
// POST /api/auth/save-token
router.post('/save-token', authController.saveFcmToken);

// جلب بيانات الموظف المرتبط بالمستخدم
// GET /api/auth/users/:userId/employee
router.get('/users/:userId/employee', authController.getEmployeeByUserId);

// تصدير الراوتر
module.exports = router;