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

    const employeeId = await employeesQueries.createEmployee(req.body);

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

// تعديل موظف
async function update(req, res) {
  try {
    const { id } = req.params;
    const { fullName } = req.body;

    if (!fullName) {
      return errorResponse(res, 'اسم الموظف مطلوب', 400);
    }

    await employeesQueries.updateEmployee(id, req.body);

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