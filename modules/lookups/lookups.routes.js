const express = require('express');
const router = express.Router();
const ctrl = require('./lookups.controller');

// ===================================
// 📢 الحملات الإعلانية
// ===================================
router.get('/ad-types', ctrl.getAdTypes);
router.post('/ad-types', ctrl.createAdType);
router.put('/ad-types/:id', ctrl.updateAdType);
router.delete('/ad-types/:id', ctrl.deleteAdType);

// ===================================
// 📱 مصادر التواصل
// ===================================
router.get('/sources', ctrl.getSources);
router.post('/sources', ctrl.createSource);
router.put('/sources/:id', ctrl.updateSource);
router.delete('/sources/:id', ctrl.deleteSource);

// ===================================
// 📊 مراحل البيع
// ===================================
router.get('/stages', ctrl.getStages);
router.post('/stages', ctrl.createStage);
router.put('/stages/:id', ctrl.updateStage);
router.delete('/stages/:id', ctrl.deleteStage);

// ===================================
// 🏷️ فئات الاهتمام
// ===================================
router.get('/categories', ctrl.getCategories);
router.post('/categories', ctrl.createCategory);
router.put('/categories/:id', ctrl.updateCategory);
router.delete('/categories/:id', ctrl.deleteCategory);

// ===================================
// 📋 حالات التواصل
// ===================================
router.get('/statuses', ctrl.getStatuses);
router.post('/statuses', ctrl.createStatus);
router.put('/statuses/:id', ctrl.updateStatus);
router.delete('/statuses/:id', ctrl.deleteStatus);

// ===================================
// ✅ أنواع المهام
// ===================================
router.get('/task-types', ctrl.getTaskTypes);
router.post('/task-types', ctrl.createTaskType);
router.put('/task-types/:id', ctrl.updateTaskType);
router.delete('/task-types/:id', ctrl.deleteTaskType);

// ===================================
// ❌ أسباب الخسارة
// ===================================
router.get('/lost-reasons', ctrl.getLostReasons);
router.post('/lost-reasons', ctrl.createLostReason);
router.put('/lost-reasons/:id', ctrl.updateLostReason);
router.delete('/lost-reasons/:id', ctrl.deleteLostReason);

module.exports = router;