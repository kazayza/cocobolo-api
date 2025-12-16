const express = require('express');
const router = express.Router();
const tasksController = require('./tasks.controller');

// ===================================
// ✅ Tasks Routes
// ===================================

// ملخص المهام
// GET /api/tasks/summary?assignedTo=xxx
router.get('/summary', tasksController.getSummary);

// مهام اليوم
// GET /api/tasks/today?assignedTo=xxx
router.get('/today', tasksController.getToday);

// المهام المتأخرة
// GET /api/tasks/overdue?assignedTo=xxx
router.get('/overdue', tasksController.getOverdue);

// جلب كل المهام
// GET /api/tasks?assignedTo=xxx&status=xxx&priority=xxx&startDate=xxx&endDate=xxx
router.get('/', tasksController.getAll);

// جلب مهمة بالـ ID
// GET /api/tasks/:id
router.get('/:id', tasksController.getById);

// إنشاء مهمة جديدة
// POST /api/tasks
router.post('/', tasksController.create);

// تعديل مهمة
// PUT /api/tasks/:id
router.put('/:id', tasksController.update);

// تحديث حالة المهمة
// PUT /api/tasks/:id/status
router.put('/:id/status', tasksController.updateStatus);

// حذف مهمة
// DELETE /api/tasks/:id
router.delete('/:id', tasksController.remove);

// تصدير الراوتر
module.exports = router;