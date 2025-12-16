const settingsQueries = require('./settings.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// جلب بيانات الشركة
async function getCompanyInfo(req, res) {
  try {
    const info = await settingsQueries.getCompanyInfo();
    return res.json(info);
  } catch (err) {
    console.error('خطأ في جلب بيانات الشركة:', err);
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

// تحديث بيانات الشركة
async function updateCompanyInfo(req, res) {
  try {
    const { companyName, address, phone1 } = req.body;

    if (!companyName || !address || !phone1) {
      return errorResponse(res, 'البيانات الأساسية مطلوبة', 400);
    }

    await settingsQueries.updateCompanyInfo(req.body);

    return res.json({
      success: true,
      message: 'تم تحديث بيانات الشركة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تحديث البيانات:', err);
    return errorResponse(res, 'فشل تحديث البيانات', 500, err.message);
  }
}

// جلب الإصدار الحالي
async function getVersion(req, res) {
  try {
    const version = await settingsQueries.getCurrentVersion();
    return res.json({ version });
  } catch (err) {
    console.error('خطأ في جلب الإصدار:', err);
    return errorResponse(res, 'فشل تحميل الإصدار', 500, err.message);
  }
}

// تحديث الإصدار
async function updateVersion(req, res) {
  try {
    const { version } = req.body;

    if (!version) {
      return errorResponse(res, 'الإصدار مطلوب', 400);
    }

    await settingsQueries.updateVersion(version);

    return res.json({
      success: true,
      message: 'تم تحديث الإصدار بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تحديث الإصدار:', err);
    return errorResponse(res, 'فشل تحديث الإصدار', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getCompanyInfo,
  updateCompanyInfo,
  getVersion,
  updateVersion
};