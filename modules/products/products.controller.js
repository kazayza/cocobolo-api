const productsQueries = require('./products.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب مجموعات المنتجات
async function getGroups(req, res) {
  try {
    const groups = await productsQueries.getProductGroups();
    return res.json(groups);
  } catch (err) {
    console.error('خطأ في جلب المجموعات:', err);
    return errorResponse(res, 'فشل تحميل المجموعات', 500, err.message);
  }
}

// جلب كل المنتجات
async function getAll(req, res) {
  try {
    const { search, groupId } = req.query;
    const products = await productsQueries.getAllProducts(search, groupId);
    return res.json(products);
  } catch (err) {
    console.error('خطأ في جلب المنتجات:', err);
    return errorResponse(res, 'فشل تحميل المنتجات', 500, err.message);
  }
}

// جلب منتج بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const product = await productsQueries.getProductById(id);

    if (!product) {
      return notFoundResponse(res, 'المنتج غير موجود');
    }

    return res.json(product);
  } catch (err) {
    console.error('خطأ في جلب المنتج:', err);
    return errorResponse(res, 'فشل تحميل المنتج', 500, err.message);
  }
}

// إضافة منتج جديد
async function create(req, res) {
  try {
    const { productName } = req.body;

    if (!productName) {
      return errorResponse(res, 'اسم المنتج مطلوب', 400);
    }

    const productId = await productsQueries.createProduct(req.body);

    return res.json({
      success: true,
      productId: productId,
      message: 'تم إضافة المنتج بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة المنتج:', err);
    return errorResponse(res, 'فشل إضافة المنتج', 500, err.message);
  }
}

// تعديل منتج
async function update(req, res) {
  try {
    const { id } = req.params;
    const { productName } = req.body;

    if (!productName) {
      return errorResponse(res, 'اسم المنتج مطلوب', 400);
    }

    await productsQueries.updateProduct(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل المنتج بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المنتج:', err);
    return errorResponse(res, 'فشل تعديل المنتج', 500, err.message);
  }
}

// إضافة صورة للمنتج
async function addImage(req, res) {
  try {
    const { id } = req.params;
    const { imageBase64, imageNote } = req.body;

    if (!imageBase64) {
      return errorResponse(res, 'الصورة مطلوبة', 400);
    }

    await productsQueries.addProductImage(id, imageBase64, imageNote);

    return res.json({
      success: true,
      message: 'تم إضافة الصورة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الصورة:', err);
    return errorResponse(res, 'فشل إضافة الصورة', 500, err.message);
  }
}

// حذف صورة
async function deleteImage(req, res) {
  try {
    const { id } = req.params;

    await productsQueries.deleteProductImage(id);

    return res.json({
      success: true,
      message: 'تم حذف الصورة'
    });
  } catch (err) {
    console.error('خطأ في حذف الصورة:', err);
    return errorResponse(res, 'فشل حذف الصورة', 500, err.message);
  }
}

// حفظ مكونات المنتج
async function saveComponents(req, res) {
  try {
    const { id } = req.params;
    const { components, createdBy } = req.body;

    if (!components || !Array.isArray(components)) {
      return errorResponse(res, 'المكونات مطلوبة', 400);
    }

    await productsQueries.saveProductComponents(id, components, createdBy);

    return res.json({
      success: true,
      message: 'تم حفظ المكونات بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حفظ المكونات:', err);
    return errorResponse(res, 'فشل حفظ المكونات', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getGroups,
  getAll,
  getById,
  create,
  update,
  addImage,
  deleteImage,
  saveComponents
};