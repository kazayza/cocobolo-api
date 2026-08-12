const express = require('express');
const router = express.Router();
const complaintsController = require('./complaints.controller');

// ===================================
// 📋 مسارات الشكاوى
// ===================================

// ✅ مسارات ثابتة
router.get('/types', complaintsController.getTypes);
router.get('/stats', complaintsController.getStats);
router.get('/', complaintsController.getAll);

// ✅ إضافة شكوى جديدة
router.post('/', complaintsController.create);

// ✅ 👈 هنا ضيف راوت المتابعات (مهم يكون قبل routes الـ /:id)
router.use('/:complaintId/followups', require('../complaint-followups/complaint-followups.routes'));

// ✅ 📎 راوتات المرفقات (كلها قبل مسارات الـ /:id)
router.get('/attachments/:attachmentId/file', complaintsController.getAttachmentFile);
router.get('/:complaintId/attachments', complaintsController.getAttachments);
router.post('/:complaintId/attachments', complaintsController.upload, complaintsController.uploadAttachment);
router.delete('/:complaintId/attachments/:attachmentId', complaintsController.deleteAttachment);

// ✅ المسارات اللي فيها :id
router.get('/:id', complaintsController.getById);
router.put('/:id', complaintsController.update);
router.delete('/:id', complaintsController.remove);

// ✅ مسار التصعيد
router.post('/:id/escalate', complaintsController.escalate);

// ✅ إسناد شكوى
router.put('/:id/assign', complaintsController.assign);

// ✅ تغيير الحالة (مع الحل)
router.put('/:id/status', complaintsController.changeStatus);

// ✅ تقييم الرضا
router.put('/:id/rate', complaintsController.rate);

module.exports = router;