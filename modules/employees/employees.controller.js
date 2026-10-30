const employeesQueries = require('./employees.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب كل الموظفين (مع فلترة)
async function getAll(req, res) {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      department: req.query.department
    };
    
    const employees = await employeesQueries.getAllEmployees(filters);
    return res.json(employees);
  } catch (err) {
    console.error('خطأ في جلب الموظفين:', err);
    return errorResponse(res, 'فشل تحميل الموظفين', 500, err.message);
  }
}

// جلب الموظفين النشطين
async function getActive(req, res) {
  try {
    const employees = await employeesQueries.getActiveEmployees();
    return res.json(employees);
  } catch (err) {
    console.error('خطأ في جلب الموظفين:', err);
    return errorResponse(res, 'فشل تحميل الموظفين', 500, err.message);
  }
}

// جلب القوائم (الأقسام والوظائف)
async function getLookups(req, res) {
  try {
    const lookups = await employeesQueries.getEmployeeLookups();
    return res.json(lookups);
  } catch (err) {
    console.error('خطأ في جلب القوائم:', err);
    return errorResponse(res, 'فشل تحميل القوائم', 500, err.message);
  }
}

// جلب موظف بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const employee = await employeesQueries.getEmployeeById(id);

    if (!employee) {
      return notFoundResponse(res, 'الموظف غير موجود');
    }

    return res.json(employee);
  } catch (err) {
    console.error('خطأ في جلب الموظف:', err);
    return errorResponse(res, 'فشل تحميل الموظف', 500, err.message);
  }
}

// إضافة موظف جديد
async function create(req, res) {
  try {
    const { fullName, nationalId } = req.body;

    if (!fullName) {
      return errorResponse(res, 'اسم الموظف مطلوب', 400);
    }

    if (!nationalId) {
      return errorResponse(res, 'الرقم القومي مطلوب', 400);
    }

    // المدير المباشر (اختياري): عند حضوره يجب أن يكون موظفًا قائمًا
    let directManagerId = null;
    if (req.body.directManagerId != null) {
      directManagerId = Number(req.body.directManagerId);
      if (!Number.isInteger(directManagerId) || directManagerId <= 0) {
        return errorResponse(res, 'معرف المدير المباشر غير صالح.', 400);
      }
      const manager = await employeesQueries.getEmployeeById(directManagerId);
      if (!manager) {
        return errorResponse(res, 'المدير المباشر المحدد غير موجود.', 400);
      }
    }

    // المنشئ من التوكن فقط؛ createdBy الجسم يُتجاهل (كان قابلًا للانتحال)
    const employeeId = await employeesQueries.createEmployee({ ...req.body, directManagerId, createdBy: req.auth.username });

    return res.json({
      success: true,
      employeeId: employeeId,
      message: 'تم إضافة الموظف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الموظف:', err);
    return errorResponse(res, 'فشل إضافة الموظف', 500, err.message);
  }
}

// تعديل موظف — تغيير المرتب الأساسي يتطلب سببًا ويُسجَّل في
// SalaryHistory داخل نفس المعاملة (مرآة قاعدة بلازور)
async function update(req, res) {
  try {
    const { id } = req.params;
    const { fullName } = req.body;

    if (!fullName) {
      return errorResponse(res, 'اسم الموظف مطلوب', 400);
    }

    const existing = await employeesQueries.getEmployeeById(id);
    if (!existing) {
      return notFoundResponse(res, 'الموظف غير موجود');
    }

    // المدير المباشر يُكتب فقط عند حضور مفتاحه في الجسم (حضوره فارغًا
    // يمسحه)؛ وعند حضوره بقيمة يجب أن يكون موظفًا قائمًا غير الموظف نفسه
    if ('directManagerId' in req.body && req.body.directManagerId != null) {
      const managerId = Number(req.body.directManagerId);
      if (!Number.isInteger(managerId) || managerId <= 0) {
        return errorResponse(res, 'معرف المدير المباشر غير صالح.', 400);
      }
      if (managerId === Number(id)) {
        return errorResponse(res, 'لا يجوز أن يكون الموظف مديرًا مباشرًا لنفسه.', 400);
      }
      const manager = await employeesQueries.getEmployeeById(managerId);
      if (!manager) {
        return errorResponse(res, 'المدير المباشر المحدد غير موجود.', 400);
      }
    }

    let salaryChange = null;
    const oldSalary = Number(existing.CurrentSalaryBase ?? 0);
    const newSalary = Number(req.body.currentSalaryBase ?? 0);
    if (newSalary !== oldSalary) {
      const reason = String(req.body.salaryChangeReason || '').trim();
      if (!reason) {
        return errorResponse(res, 'سبب تغيير المرتب مطلوب عند تعديل المرتب الأساسي.', 400);
      }
      salaryChange = { oldSalary, newSalary, reason, changedBy: req.auth.username };
    }

    await employeesQueries.updateEmployee(id, req.body, salaryChange);

    return res.json({
      success: true,
      message: 'تم تعديل الموظف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل الموظف:', err);
    return errorResponse(res, 'فشل تعديل الموظف', 500, err.message);
  }
}

// تغيير حالة الموظف
async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return errorResponse(res, 'الحالة مطلوبة', 400);
    }

    await employeesQueries.updateEmployeeStatus(id, status);

    return res.json({
      success: true,
      message: 'تم تغيير حالة الموظف بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تغيير الحالة:', err);
    return errorResponse(res, 'فشل تغيير الحالة', 500, err.message);
  }
}

// جلب سجل الرواتب
async function getSalaryHistory(req, res) {
  try {
    const { id } = req.params;
    const history = await employeesQueries.getSalaryHistory(id);
    return res.json(history);
  } catch (err) {
    console.error('خطأ في جلب سجل الرواتب:', err);
    return errorResponse(res, 'فشل تحميل السجل', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getActive,
  getLookups,
  getById,
  create,
  update,
  updateStatus,
  getSalaryHistory
};