const tasksQueries = require('./tasks.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب كل المهام
async function getAll(req, res) {
  try {
    //const { assignedTo, status, priority, startDate, endDate } = req.query;
    const { assignedTo, status, priority, startDate, endDate, opportunityEmployeeId } = req.query;
    const tasks = await tasksQueries.getAllTasks({
      assignedTo, status, priority, startDate, endDate, opportunityEmployeeId
    });
    return res.json(tasks);
  } catch (err) {
    console.error('خطأ في جلب المهام:', err);
    return errorResponse(res, 'فشل تحميل المهام', 500, err.message);
  }
}

// جلب مهام اليوم
async function getToday(req, res) {
  try {
    const { assignedTo } = req.query;
    const tasks = await tasksQueries.getTodayTasks(assignedTo);
    return res.json(tasks);
  } catch (err) {
    console.error('خطأ في جلب مهام اليوم:', err);
    return errorResponse(res, 'فشل تحميل المهام', 500, err.message);
  }
}

// جلب المهام المتأخرة
async function getOverdue(req, res) {
  try {
    const { assignedTo } = req.query;
    const tasks = await tasksQueries.getOverdueTasks(assignedTo);
    return res.json(tasks);
  } catch (err) {
    console.error('خطأ في جلب المهام المتأخرة:', err);
    return errorResponse(res, 'فشل تحميل المهام', 500, err.message);
  }
}

// ملخص المهام
async function getSummary(req, res) {
  try {
    const { assignedTo } = req.query;
    const summary = await tasksQueries.getTasksSummary(assignedTo);
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// جلب مهمة بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const task = await tasksQueries.getTaskById(id);

    if (!task) {
      return notFoundResponse(res, 'المهمة غير موجودة');
    }

    return res.json(task);
  } catch (err) {
    console.error('خطأ في جلب المهمة:', err);
    return errorResponse(res, 'فشل تحميل المهمة', 500, err.message);
  }
}

// إنشاء مهمة
async function create(req, res) {
  try {
    const { assignedTo, dueDate, createdBy } = req.body;

    if (!assignedTo || !dueDate) {
      return errorResponse(res, 'الموظف المسؤول وتاريخ الاستحقاق مطلوبين', 400);
    }

    const taskId = await tasksQueries.createTask(req.body);

    return res.json({
      success: true,
      taskId: taskId,
      message: 'تم إنشاء المهمة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء المهمة:', err);
    return errorResponse(res, 'فشل إنشاء المهمة', 500, err.message);
  }
}

// تعديل مهمة
async function update(req, res) {
  try {
    const { id } = req.params;

    await tasksQueries.updateTask(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل المهمة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المهمة:', err);
    return errorResponse(res, 'فشل تعديل المهمة', 500, err.message);
  }
}

// تحديث حالة المهمة
async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, completedBy, completionNotes } = req.body;

    if (!status) {
      return errorResponse(res, 'الحالة مطلوبة', 400);
    }

    await tasksQueries.updateTaskStatus(id, status, completedBy, completionNotes);

    return res.json({
      success: true,
      message: 'تم تحديث حالة المهمة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تحديث الحالة:', err);
    return errorResponse(res, 'فشل تحديث الحالة', 500, err.message);
  }
}

// حذف مهمة
async function remove(req, res) {
  try {
    const { id } = req.params;

    await tasksQueries.deleteTask(id);

    return res.json({
      success: true,
      message: 'تم حذف المهمة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف المهمة:', err);
    return errorResponse(res, 'فشل حذف المهمة', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getToday,
  getOverdue,
  getSummary,
  getById,
  create,
  update,
  updateStatus,
  remove
};