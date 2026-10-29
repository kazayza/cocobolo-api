const tasksQueries = require('./tasks.queries');
const policy = require('../../shared/authorization.policy');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// ═══════════════════════════════════════════════════════════
// الهوية (مرحلة 1 — الحزمة C): الفاعل هو مستخدم التوكن دائمًا (req.auth).
// لا يُقرأ اسم المستخدم/الدور/المنشئ من query أو الترويسات أو الجسم إطلاقًا —
// كانت تلك ثغرة انتحال (عالٍ-16): أي مرسِل يعلن نفسه أي موظف.
// مصدر الإسناد يُحسم خادميًا من الدور كما في بلازور
// (TaskService.ResolveGeneralTaskAssignmentSource).
// ═══════════════════════════════════════════════════════════
function resolveGeneralTaskAssignmentSource(auth) {
  if (policy.roles.generalManager(auth)) return 'GeneralManager';
  if (policy.roles.accountManager(auth)) return 'AccountManager';
  if (policy.roles.admin(auth)) return 'Admin';
  return 'GeneralTask';
}

const SQL_INT_MAX = 2147483647;

function parseTaskId(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;

  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0 || id > SQL_INT_MAX) return null;
  return id;
}

function invalidTaskIdResponse(res) {
  return errorResponse(res, 'معرّف المهمة غير صالح', 400);
}

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
    const id = parseTaskId(req.params.id);
    if (id === null) return invalidTaskIdResponse(res);

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
    const { assignedTo, dueDate } = req.body;

    if (!assignedTo || !dueDate) {
      return errorResponse(res, 'الموظف المسؤول وتاريخ الاستحقاق مطلوبين', 400);
    }

    // المنشئ هو مستخدم التوكن — أي createdBy في الجسم يُتجاهل.
    const taskId = await tasksQueries.createTask({ ...req.body, createdBy: req.auth.username });

    return res.json({
      success: true,
      taskId: taskId,
      message: 'تم إنشاء المهمة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء المهمة:', err);
    return errorResponse(
      res,
      err.statusCode ? err.message : 'فشل إنشاء المهمة',
      err.statusCode || 500,
      err.code || err.message,
    );
  }
}

// تعديل مهمة
async function update(req, res) {
  try {
    const id = parseTaskId(req.params.id);
    if (id === null) return invalidTaskIdResponse(res);

    await tasksQueries.updateTask(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل المهمة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المهمة:', err);
    return errorResponse(
      res,
      err.statusCode ? err.message : 'فشل تعديل المهمة',
      err.statusCode || 500,
      err.code || err.message,
    );
  }
}

// تحديث حالة المهمة
async function updateStatus(req, res) {
  try {
    const id = parseTaskId(req.params.id);
    if (id === null) return invalidTaskIdResponse(res);

    const { status, completionNotes } = req.body;

    if (!status) {
      return errorResponse(res, 'الحالة مطلوبة', 400);
    }

    // المُتمّ هو مستخدم التوكن — أي completedBy في الجسم يُتجاهل.
    await tasksQueries.updateTaskStatus(id, status, req.auth.username, completionNotes);

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
    const id = parseTaskId(req.params.id);
    if (id === null) return invalidTaskIdResponse(res);

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
    // الهوية من التوكن فقط؛ نطاق القراءة (مدير يرى الكل / غيره يرى ما يخصه)
    // يُطبق داخل الاستعلام كما في بلازور GetGeneralTasksAsync.
    const tasks = await tasksQueries.getGeneralTasks(req.auth);
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
    // حارس الإنشاء — بلازور AddGeneralEmployeeTaskAsync: الأدوار الثلاثة
    // أو Claim الإنشاء (GeneralTaskPermissions.CanCreate)؛ قبله كان الإنشاء
    // متاحًا لأي جلسة وبهوية معلنة من العميل.
    if (!policy.generalTasks.canCreate(req.auth)) {
      return errorResponse(res, 'ليست لديك صلاحية إنشاء مهام عامة للموظفين.', 403);
    }
    const taskId = await tasksQueries.createGeneralTask({
      assignedTo: req.body.assignedTo,
      taskTypeId: req.body.taskTypeId,
      taskDescription: req.body.taskDescription,
      dueDate: req.body.dueDate,
      dueTime: req.body.dueTime,
      priority: req.body.priority,
      // مصدر الإسناد يُحسم من دور المنشئ خادميًا — لا من الجسم.
      assignmentSource: resolveGeneralTaskAssignmentSource(req.auth),
    }, req.auth);
    return res.json({ success: true, taskId, message: 'تم إرسال التكليف بنجاح' });
  } catch (err) {
    console.error('createGeneral:', err);
    return errorResponse(
      res,
      err.statusCode ? err.message : 'فشل إنشاء التكليف العام',
      err.statusCode || 500,
      err.code || err.message,
    );
  }
}

async function startTask(req, res) {
  try {
    const id = parseTaskId(req.params.id);
    if (id === null) return invalidTaskIdResponse(res);

    // الفاعل هو مستخدم التوكن؛ فحوص الحالة والملكية والملاحظة تتم داخل
    // الاستعلام بنفس ترتيب بلازور StartAsync (الحالة قبل الملاحظة).
    const result = await tasksQueries.startGeneralTask(id, req.body?.notes, req.auth);
    return res.json({ success: true, message: result?.message || 'تم بدء التنفيذ' });
  } catch (err) {
    console.error('startTask:', err);
    return errorResponse(
      res,
      err.statusCode ? err.message : 'فشل بدء التنفيذ',
      err.statusCode || 500,
      err.code || err.message,
    );
  }
}

async function completeTask(req, res) {
  try {
    const id = parseTaskId(req.params.id);
    if (id === null) return invalidTaskIdResponse(res);

    // الفاعل هو مستخدم التوكن؛ فحوص الملاحظة والحالة والملكية داخل
    // الاستعلام بنفس ترتيب بلازور CompleteAsync (الملاحظة قبل الحالة).
    const result = await tasksQueries.completeGeneralTask(id, req.body?.notes, req.auth);
    return res.json({ success: true, message: result?.message || 'تم إتمام التنفيذ' });
  } catch (err) {
    console.error('completeTask:', err);
    return errorResponse(
      res,
      err.statusCode ? err.message : 'فشل إتمام التنفيذ',
      err.statusCode || 500,
      err.code || err.message,
    );
  }
}

// عدّاد إشاراتي (@) لشريط «مهامي» في الرئيسية — الهوية من التوكن فقط
async function getMyMentionsCount(req, res) {
  try {
    const count = await tasksQueries.getMyMentionsCount(req.auth);
    return res.json({ success: true, data: { count } });
  } catch (err) {
    console.error('خطأ في جلب عدد الإشارات:', err);
    return errorResponse(res, 'فشل تحميل عدد الإشارات', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getToday,
  getOverdue,
  getSummary,
  getMyMentionsCount,
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