const express = require('express');
const router = express.Router();
const complaintsController = require('./complaints.controller');

// ===================================
// 📋 مسارات الشكاوى
// ===================================

// ✅ مسارات ثابتة
router.get('/types', complaintsController.getTypes);
router.get('/', complaintsController.getAll);

// ✅ إضافة شكوى جديدة
router.post('/', complaintsController.create);

// ✅ المسارات اللي فيها :id
router.get('/:id', complaintsController.getById);
router.put('/:id', complaintsController.update);
router.delete('/:id', complaintsController.remove);

// ✅ مسار التصعيد
router.post('/:id/escalate', complaintsController.escalate);

module.exports = router;