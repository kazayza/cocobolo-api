const express = require('express');
const router = express.Router();
const controller = require('./admin-users.controller');

// ═══════════════════════════════════════════════════════════
// إدارة المستخدمين والصلاحيات (Admin)
// ═══════════════════════════════════════════════════════════

// ── المستخدمون ──────────────────────────────────────────────
router.get('/users', controller.listUsers);
router.get('/users/:id', controller.getUser);
router.post('/users', controller.createUser);
router.put('/users/:id', controller.updateUser);
router.delete('/users/:id', controller.deleteUser);

// ── الصلاحيات ───────────────────────────────────────────────
router.get('/permissions', controller.listPermissions);
router.get('/users/:id/permissions', controller.getUserPermissions);
router.put('/users/:id/permissions', controller.saveUserPermissions);

module.exports = router;
