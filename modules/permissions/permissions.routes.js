const express = require('express');
const router = express.Router();
const permissionsController = require('./permissions.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// ==========================
// 📝 Permission Routes
// ==========================

// تقديم طلب جديد — الهوية من التوكن فقط (userId/employeeId في الجسم يُتجاهلان)
// Body: { permissionDate, type, reason, createdAt, fromTime, toTime }
router.post('/request', permissionsController.requestPermission);

// عرض القائمة — الدور من التوكن: المدير يرى الكل، والموظف يرى طلباته فقط
// Query: ?status=Pending&employeeName=... (&employeeId للمدير فقط)
router.get('/list', permissionsController.listPermissions);

// اتخاذ إجراء (موافقة/رفض) — مدير فقط، والطلب معلق فقط
// Body: { permissionId, status: 'Approved'|'Rejected', comment }
router.post('/action', permissionsController.takeAction);

module.exports = router;