const express = require('express');
const router = express.Router();
const permissionsController = require('./permissions.controller');

// ==========================
// 📝 Permission Routes
// ==========================

// تقديم طلب جديد
// Body: { userId, employeeId, permissionDate, type, reason, createdAt, ... }
router.post('/request', permissionsController.requestPermission);

// عرض القائمة
// Query: ?role=Admin&status=Pending (Manager)
// Query: ?employeeId=5 (User)
router.get('/list', permissionsController.listPermissions);

// اتخاذ إجراء (موافقة/رفض)
// Body: { permissionId, status: 'Approved', comment, userId }
router.post('/action', permissionsController.takeAction);

module.exports = router;