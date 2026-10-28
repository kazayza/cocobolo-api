const express = require('express');
const router = express.Router();
const controller = require('./admin-users.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { roles } = require('../../shared/authorization.policy');

// ═══════════════════════════════════════════════════════════
// إدارة المستخدمين والصلاحيات (Admin)
// Phase 0: كان الراوتر مفتوحًا بالكامل (حرج-2) — الآن جلسة + بوابة Admin
// على مستوى الراوتر كله قبل أي مسار.
// ═══════════════════════════════════════════════════════════

router.use(authenticate);
router.use(requirePolicy(roles.admin, 'إدارة المستخدمين والصلاحيات متاحة للأدمن فقط'));

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
