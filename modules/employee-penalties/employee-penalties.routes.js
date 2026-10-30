const express = require('express');
const router = express.Router();
const penaltiesController = require('./employee-penalties.controller');
const { authenticate } = require('../../core/auth.middleware');

// ===================================
// ⚖️ Employee Penalties Routes — نظام الجزاءات (المرحلة ١)
// deny-by-default: كل مسارات الوحدة بجلسة صالحة، والبوابات الدقيقة
// (الأدوار / المدير المباشر / التوقيع المباشر / منع الاعتماد الذاتي)
// داخل المتحكم لأنها تعتمد على بيانات الموظف المستهدف نفسه.
// ===================================

router.use(authenticate);

// محاكاة قيمة اليوم والمبلغ — قبل /:id حتى لا تُلتقط كمعرف
// GET /api/employee-penalties/preview?employeeId=&month=&days=
router.get('/preview', penaltiesController.preview);

// طابور الاعتماد لأصحاب التوقيع المباشر
// GET /api/employee-penalties/pending
router.get('/pending', penaltiesController.listPending);

// جزاءات موظف بعينه (رؤيتها مضبوطة داخل المتحكم)
// GET /api/employee-penalties/employee/:id
router.get('/employee/:id', penaltiesController.getByEmployee);

// قائمة الجزاءات بمرشحات employeeId/status/month
// GET /api/employee-penalties
router.get('/', penaltiesController.list);

// إنشاء جزاء
// POST /api/employee-penalties
router.post('/', penaltiesController.create);

// اعتماد جزاء معلق (توقيع مباشر، بلا اعتماد ذاتي)
// POST /api/employee-penalties/:id/approve
router.post('/:id/approve', penaltiesController.approve);

// رفض جزاء معلق
// POST /api/employee-penalties/:id/reject
router.post('/:id/reject', penaltiesController.reject);

// إلغاء جزاء (المنشئ أو صاحب توقيع مباشر؛ ممنوع بعد التطبيق)
// POST /api/employee-penalties/:id/cancel
router.post('/:id/cancel', penaltiesController.cancel);

module.exports = router;
