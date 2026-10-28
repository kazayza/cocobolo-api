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
// Phase 0: كانت عامة (تخمين تسلسلي) — الآن بجلسة.
router.get('/users/:userId/employee', authenticate, authController.getEmployeeByUserId);

// Phase 0: تغيير كلمة المرور بجلسة، والهدف مستخدم التوكن (أو آخر عند الأدمن) — عالٍ-9.
router.post('/change-password', authenticate, authController.changePassword);

// تصدير الراوتر
module.exports = router;