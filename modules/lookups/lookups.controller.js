const lookupsQueries = require('./lookups.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// ===================================
// 📢 الحملات الإعلانية (AdTypes)
// ===================================

async function getAdTypes(req, res) {
  try {
    const items = await lookupsQueries.getAll('AdTypes', 'AdTypeID');
    return res.json(items);
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createAdType(req, res) {
  try {
    const { nameAr, nameEn, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('AdTypes', {
      AdTypeName: nameEn || nameAr,
      AdTypeNameAr: nameAr,
      IsActive: 1,
      CreatedBy: createdBy
    });

    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateAdType(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('AdTypes', 'AdTypeID', id, {
      AdTypeName: nameEn || nameAr,
      AdTypeNameAr: nameAr,
      UpdatedBy: updatedBy
    });

    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteAdType(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('AdTypes', 'AdTypeID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

// ===================================
// 📱 مصادر التواصل (ContactSources)
// ===================================

async function getSources(req, res) {
  try {
    const items = await lookupsQueries.getAll('ContactSources', 'SourceID');
    return res.json(items);
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createSource(req, res) {
  try {
    const { nameAr, nameEn, icon, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('ContactSources', {
      SourceName: nameEn || nameAr,
      SourceNameAr: nameAr,
      SourceIcon: icon || '📞',
      IsActive: 1,
      CreatedBy: createdBy
    });

    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateSource(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, icon, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('ContactSources', 'SourceID', id, {
      SourceName: nameEn || nameAr,
      SourceNameAr: nameAr,
      SourceIcon: icon || '📞',
      UpdatedBy: updatedBy
    });

    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteSource(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('ContactSources', 'SourceID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    console.error('خطأ:', err);
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

module.exports = {
  getAdTypes, createAdType, updateAdType, deleteAdType,
  getSources, createSource, updateSource, deleteSource,
};