const shiftsQueries = require('./shifts.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// دالة مساعدة لتوقيت مصر
function getEgyptTime() {
  const date = new Date();
  return new Date(date.toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
}

// جلب شيفتات موظف
async function getByEmployee(req, res) {
  try {
    const { id } = req.params;
    const shifts = await shiftsQueries.getShiftsByEmployee(id);
    return res.json(shifts);
  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل جلب الشيفتات', 500, err.message);
  }
}

// إضافة شيفت
async function create(req, res) {
  try {
    const { employeeId, shiftType, startTime, endTime, effectiveFrom, createdBy } = req.body;

    if (!employeeId || !shiftType || !startTime || !endTime || !effectiveFrom) {
      return errorResponse(res, 'البيانات ناقصة', 400);
    }

    // ✅ تحديد توقيت الإنشاء بتوقيت مصر
    const createdAt = getEgyptTime();

    const shiftId = await shiftsQueries.createShift({
      ...req.body,
      createdBy: createdBy || 'Unknown',
      createdAt: createdAt // هنبعت الوقت ده للـ Query
    });

    return res.json({ 
      success: true, 
      shiftId, 
      message: 'تم إضافة الشيفت وتحديث المواعيد بنجاح' 
    });

  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل إضافة الشيفت', 500, err.message);
  }
}

// حذف شيفت
async function remove(req, res) {
  try {
    const { id } = req.params;
    await shiftsQueries.deleteShift(id);
    return res.json({ success: true, message: 'تم حذف الشيفت' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500);
  }
}

async function getEmployeesShiftsStatus(req, res) {
  try {
    const data = await shiftsQueries.getEmployeesWithCurrentShift();
    return res.json(data);
  } catch (err) {
    return errorResponse(res, 'فشل جلب بيانات الموظفين', 500);
  }
}

// البحث في الشيفتات
async function search(req, res) {
  try {
    const filters = {
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
      shiftType: req.query.shiftType,
      employeeName: req.query.employeeName
    };

    const shifts = await shiftsQueries.searchShifts(filters);
    return res.json(shifts);
  } catch (err) {
    console.error(err);
    return errorResponse(res, 'فشل البحث في الشيفتات', 500);
  }
}



module.exports = {
  getByEmployee,
  create,
  remove,
  getEmployeesShiftsStatus,
  search
};