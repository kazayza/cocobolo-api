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

// ═══════════════════════════════════════════════════════════
// التكليفات العامة - مطابقة بلازور GeneralTasks
// ═══════════════════════════════════════════════════════════

async function getGeneral(req, res) {
  try {
    const userName = req.query.userName || req.headers['x-username'] || req.body?.userName || 'System';
    const tasks = await tasksQueries.getGeneralTasks(userName, req.query);
    return res.json(tasks);
  } catch (err) {
    console.error('getGeneral:', err);
    return errorResponse(res, 'فشل تحميل التكليفات العامة', 500, err.message);
  }
}

async function createGeneral(req, res) {
  try {
    const { assignedTo, taskDescription, dueDate } = req.body;
    if (!assignedTo || !taskDescription || !dueDate) {
      return errorResponse(res, 'الموظف ووصف المهمة وتاريخ التنفيذ مطلوبين', 400);
    }
    const userName = req.body.userName || req.headers['x-username'] || 'System';
    const taskId = await tasksQueries.createGeneralTask({
      assignedTo: req.body.assignedTo,
      taskTypeId: req.body.taskTypeId,
      taskDescription: req.body.taskDescription,
      dueDate: req.body.dueDate,
      dueTime: req.body.dueTime,
      priority: req.body.priority,
      assignmentSource: req.body.assignmentSource || req.body.actorRole || 'Admin',
    }, userName);
    return res.json({ success: true, taskId, message: 'تم إرسال التكليف بنجاح' });
  } catch (err) {
    console.error('createGeneral:', err);
    return errorResponse(res, 'فشل إنشاء التكليف العام', 500, err.message);
  }
}

async function startTask(req, res) {
  try {
    const { id } = req.params;
    const { notes, userName } = req.body;
    if (!notes) return errorResponse(res, 'اكتب ماذا ستبدأ', 400);
    await tasksQueries.startGeneralTask(parseInt(id, 10), notes, userName || 'System');
    return res.json({ success: true, message: 'تم بدء التنفيذ' });
  } catch (err) {
    console.error('startTask:', err);
    return errorResponse(res, 'فشل بدء التنفيذ', 500, err.message);
  }
}

async function completeTask(req, res) {
  try {
    const { id } = req.params;
    const { notes, userName } = req.body;
    if (!notes) return errorResponse(res, 'اكتب ما تم تنفيذه', 400);
    await tasksQueries.completeGeneralTask(parseInt(id, 10), notes, userName || 'System');
    return res.json({ success: true, message: 'تم إتمام التنفيذ' });
  } catch (err) {
    console.error('completeTask:', err);
    return errorResponse(res, 'فشل إتمام التنفيذ', 500, err.message);
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
  remove,
  getGeneral,
  createGeneral,
  startTask,
  completeTask,
};