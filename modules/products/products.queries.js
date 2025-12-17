const { sql, connectDB } = require('../../core/database');

// جلب مجموعات المنتجات
async function getProductGroups() {
  const pool = await connectDB();
  const result = await pool.request()
    .query('SELECT ProductGroupID, GroupName FROM ProductGroups ORDER BY GroupName');
  return result.recordset;
}

// جلب كل المنتجات مع الفلترة
async function getAllProducts(search = '', groupId = null) {
  const pool = await connectDB();

  let query = `
    SELECT 
      p.ProductID,
      p.ProductName,
      p.ProductDescription,
      p.SuggestedSalePrice,
      p.PurchasePrice,
      p.QTY,
      p.Period,
      p.PricingType,
      p.Customer,
      p.PurchasePriceElite,
      p.SuggestedSalePriceElite,
      pg.ProductGroupID,
      pg.GroupName,
      pa.PartyName AS CustomerName
    FROM Products p
    INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
    LEFT JOIN Parties pa ON p.Customer = pa.PartyID
    WHERE 1=1
  `;

  const request = pool.request();

  // فلتر البحث
  if (search && search.trim() !== '') {
    query += ` AND (p.ProductName LIKE @search OR pa.PartyName LIKE @search)`;
    request.input('search', sql.NVarChar, `%${search}%`);
  }

  // فلتر المجموعة
  if (groupId && groupId !== '' && groupId !== '0') {
    query += ` AND p.ProductGroupID = @groupId`;
    request.input('groupId', sql.Int, groupId);
  }

  query += ` ORDER BY p.ProductID DESC`;

  const result = await request.query(query);

  // ✅ نرجّع الـ recordset زي ما هو، من غير ما نحول أي صور
  return result.recordset;
}

// جلب منتج بالـ ID
async function getProductById(id) {
  const pool = await connectDB();

  // جلب بيانات المنتج
  const productResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT p.*, pg.GroupName, pa.PartyName AS CustomerName
      FROM Products p
      INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
      LEFT JOIN Parties pa ON p.Customer = pa.PartyID
      WHERE p.ProductID = @id
    `);

  if (productResult.recordset.length === 0) {
    return null;
  }

  // جلب صور المنتج
  const imagesResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT ProductImagesID, ImageNote, CAST(ImageProduct AS VARBINARY(MAX)) AS ImageProduct
      FROM ProductImages WHERE ProductID = @id
    `);

  // جلب مكونات المنتج
  const componentsResult = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT ComponentID, ComponentName, Quantity FROM ProductComponents WHERE ProductID = @id');

  return {
    ...productResult.recordset[0],
    images: imagesResult.recordset.map(img => ({
      id: img.ProductImagesID,
      note: img.ImageNote,
      image: img.ImageProduct ? Buffer.from(img.ImageProduct).toString('base64') : null
    })),
    components: componentsResult.recordset
  };
}

// إضافة منتج جديد
async function createProduct(productData) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('productName', sql.NVarChar(100), productData.productName)
    .input('productDescription', sql.NVarChar(150), productData.productDescription || '')
    .input('manufacturingDescription', sql.NVarChar(sql.MAX), productData.manufacturingDescription)
    .input('productGroupId', sql.Int, productData.productGroupId)
    .input('customerId', sql.Int, productData.customerId || null)
    .input('purchasePrice', sql.Decimal(18, 2), productData.purchasePrice || 0)
    .input('suggestedSalePrice', sql.Decimal(18, 2), productData.suggestedSalePrice || 0)
    .input('purchasePriceElite', sql.Decimal(18, 2), productData.purchasePriceElite || 0)          // ✅
    .input('suggestedSalePriceElite', sql.Decimal(18, 2), productData.suggestedSalePriceElite || 0)// ✅
    .input('pricingType', sql.NVarChar(50), productData.pricingType)
    .input('qty', sql.Int, productData.qty || 1)
    .input('period', sql.Int, productData.period || 0)
    .input('createdBy', sql.NVarChar(100), productData.createdBy)
    .query(`
      INSERT INTO Products (
        ProductName, ProductDescription, ManufacturingDescription,
        ProductGroupID, Customer, PurchasePrice, SuggestedSalePrice,
        PurchasePriceElite, SuggestedSalePriceElite,                -- ✅
        PricingType, QTY, Period, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.ProductID
      VALUES (
        @productName, @productDescription, @manufacturingDescription,
        @productGroupId, @customerId, @purchasePrice, @suggestedSalePrice,
        @purchasePriceElite, @suggestedSalePriceElite,              -- ✅
        @pricingType, @qty, @period, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].ProductID;
}

// تعديل منتج
async function updateProduct(id, productData) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('productName', sql.NVarChar(100), productData.productName)
    .input('productDescription', sql.NVarChar(150), productData.productDescription || '')
    .input('manufacturingDescription', sql.NVarChar(sql.MAX), productData.manufacturingDescription)
    .input('productGroupId', sql.Int, productData.productGroupId)
    .input('customerId', sql.Int, productData.customerId || null)
    .input('purchasePrice', sql.Decimal(18, 2), productData.purchasePrice || 0)
    .input('suggestedSalePrice', sql.Decimal(18, 2), productData.suggestedSalePrice || 0)
     .input('purchasePriceElite', sql.Decimal(18, 2), productData.purchasePriceElite || 0)          // ✅
    .input('suggestedSalePriceElite', sql.Decimal(18, 2), productData.suggestedSalePriceElite || 0)// ✅
    .input('pricingType', sql.NVarChar(50), productData.pricingType)
    .input('qty', sql.Int, productData.qty || 1)
    .input('period', sql.Int, productData.period || 0)
    .query(`
      UPDATE Products SET
        ProductName = @productName, ProductDescription = @productDescription,
        ManufacturingDescription = @manufacturingDescription,
        ProductGroupID = @productGroupId, Customer = @customerId,
        PurchasePrice = @purchasePrice, SuggestedSalePrice = @suggestedSalePrice,
         PurchasePriceElite = @purchasePriceElite,                      -- ✅
        SuggestedSalePriceElite = @suggestedSalePriceElite,            -- ✅
        PricingType = @pricingType, QTY = @qty, Period = @period
      WHERE ProductID = @id
    `);
  return true;
}

// إضافة صورة للمنتج
async function addProductImage(productId, imageBase64, imageNote) {
  const pool = await connectDB();
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  await pool.request()
    .input('productId', sql.Int, productId)
    .input('imageProduct', sql.VarBinary(sql.MAX), imageBuffer)
    .input('imageNote', sql.NVarChar(255), imageNote || '')
    .query(`
      INSERT INTO ProductImages (ProductID, ImageProduct, ImagePath, ImageNote, CreatedAt)
      VALUES (@productId, @imageProduct, '', @imageNote, GETDATE())
    `);
  return true;
}

// حذف صورة
async function deleteProductImage(imageId) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, imageId)
    .query('DELETE FROM ProductImages WHERE ProductImagesID = @id');
  return true;
}

// حفظ مكونات المنتج
async function saveProductComponents(productId, components, createdBy) {
  const pool = await connectDB();

  // حذف المكونات القديمة
  await pool.request()
    .input('productId', sql.Int, productId)
    .query('DELETE FROM ProductComponents WHERE ProductID = @productId');

  // إضافة المكونات الجديدة
  for (const comp of components) {
    await pool.request()
      .input('productId', sql.Int, productId)
      .input('componentName', sql.NVarChar(100), comp.componentName)
      .input('quantity', sql.Int, comp.quantity)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO ProductComponents (ProductID, ComponentName, Quantity, CreatedBy, CreatedAt)
        VALUES (@productId, @componentName, @quantity, @createdBy, GETDATE())
      `);
  }
  return true;
}

// تصدير الدوال
module.exports = {
  getProductGroups,
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  addProductImage,
  deleteProductImage,
  saveProductComponents
};