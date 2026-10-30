const express = require('express');
const router = express.Router();
const tasksController = require('./tasks.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// ===================================
// Tasks Routes
// ===================================

// المسارات الثابتة يجب أن تسبق /:id حتى لا تُفسَّر كلمات مثل "general" كرقم مهمة.

// ملخص المهام
// GET /api/tasks/summary?assignedTo=xxx
router.get('/summary', tasksController.getSummary);

// عدّاد إشاراتي (@) لشريط «مهامي» — الهوية من التوكن فقط
// GET /api/tasks/my-mentions-count
router.get('/my-mentions-count', tasksController.getMyMentionsCount);

// «إشاراتي» — تكليفات عامة ذُكر فيها موظف التوكن (الأحدث ذكرًا أولًا)
// GET /api/tasks/my-mentions
router.get('/my-mentions', tasksController.getMyMentions);

// مهام اليوم
// GET /api/tasks/today?assignedTo=xxx
router.get('/today', tasksController.getToday);

// المهام المتأخرة
// GET /api/tasks/overdue?assignedTo=xxx
router.get('/overdue', tasksController.getOverdue);

// التكليفات العامة - مطابقة بلازور GeneralTasks
router.get('/general', tasksController.getGeneral);
router.post('/general', tasksController.createGeneral);

// جلب كل المهام
// GET /api/tasks?assignedTo=xxx&status=xxx&priority=xxx&startDate=xxx&endDate=xxx
router.get('/', tasksController.getAll);

// إنشاء مهمة جديدة
// POST /api/tasks
router.post('/', tasksController.create);

// جلب مهمة بالـ ID
// GET /api/tasks/:id
router.get('/:id', tasksController.getById);

// تعديل مهمة
// PUT /api/tasks/:id
router.put('/:id', tasksController.update);

// تحديث حالة المهمة
// PUT /api/tasks/:id/status
router.put('/:id/status', tasksController.updateStatus);

// حذف مهمة
// DELETE /api/tasks/:id
router.delete('/:id', tasksController.remove);

router.post('/:id/start', tasksController.startTask);
router.post('/:id/complete', tasksController.completeTask);

// منصة التكليفات العامة — استلام/إرجاع/إلغاء موثّقة + خيط النقاش
router.post('/:id/acknowledge', tasksController.acknowledgeTask);
router.post('/:id/return', tasksController.returnTask);
router.post('/:id/cancel', tasksController.cancelTask);
router.get('/:id/comments', tasksController.getComments);
router.post('/:id/comments', tasksController.addComment);

// مجدول تذكيرات التكليفات العامة — يبدأ مع إقلاع الوحدة (مرآة
// GeneralTaskReminderService في بلازور)؛ فشله لا يُسقط الخادم أبدًا.
try {
  require('./task-reminder.scheduler').startTaskReminderScheduler();
} catch (e) {
  console.error('task reminder scheduler:', e.message);
}

module.exports = router;
