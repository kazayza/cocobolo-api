const express = require('express');
const router = express.Router();
const settingsController = require('./settings.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { settings: settingsPolicy } = require('../../shared/authorization.policy');

// ===================================
// ⚙️ Settings Routes
// Phase 0: كانت الوحدة مفتوحة بالكامل — الآن جلسة + سياسات (التعديل للأدمن فقط).
// ===================================

router.use(authenticate);

const canView = requirePolicy(settingsPolicy.canView, 'غير مصرح لك بعرض الإعدادات');
const canManage = requirePolicy(settingsPolicy.canManage, 'غير مصرح لك بتعديل الإعدادات');

// جلب بيانات الشركة
// GET /api/settings/company
router.get('/company', canView, settingsController.getCompanyInfo);

// تحديث بيانات الشركة
// PUT /api/settings/company
router.put('/company', canManage, settingsController.updateCompanyInfo);

// جلب الإصدار الحالي
// GET /api/settings/version
router.get('/version', canView, settingsController.getVersion);

// تحديث الإصدار
// PUT /api/settings/version
router.put('/version', canManage, settingsController.updateVersion);

// تصدير الراوتر
module.exports = router;
