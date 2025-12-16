const express = require('express');
const router = express.Router();
const settingsController = require('./settings.controller');

// ===================================
// ⚙️ Settings Routes
// ===================================

// جلب بيانات الشركة
// GET /api/settings/company
router.get('/company', settingsController.getCompanyInfo);

// تحديث بيانات الشركة
// PUT /api/settings/company
router.put('/company', settingsController.updateCompanyInfo);

// جلب الإصدار الحالي
// GET /api/settings/version
router.get('/version', settingsController.getVersion);

// تحديث الإصدار
// PUT /api/settings/version
router.put('/version', settingsController.updateVersion);

// تصدير الراوتر
module.exports = router;