const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// إعدادات الاتصال
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT || '1433'),
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// اتصال واحد مرة واحدة فقط
let pool;
async function connectDB() {
  try {
    if (!pool) {
      pool = await sql.connect(config);
      console.log('✅ متصل بقاعدة البيانات بنجاح');
    }
    return pool;
  } catch (err) {
    console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.message);
    throw err;
  }
}

// تشغيل الاتصال
connectDB();

// ==========================
// الـ Endpoints
// ==========================

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('username', sql.NVarChar, req.body.username)
      .input('password', sql.NVarChar, req.body.password)
      .query(`
        SELECT UserID, Username, FullName, Email, employeeID 
        FROM Users 
        WHERE Username = @username 
          AND Password = @password 
          AND IsActive = 1
      `);

    if (result.recordset.length > 0) {
      res.json({ success: true, user: result.recordset[0] });
    } else {
      res.json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
  } catch (err) {
    console.error('خطأ في تسجيل الدخول:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// جلب العملاء
app.get('/api/clients', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT 
          PartyID,
          PartyName,
          Phone,
          Phone2,
          Email,
          Address,
          TaxNumber,
          OpeningBalance,
          BalanceType,
          ContactPerson,
          NationalID
        FROM Parties 
        WHERE PartyType = 1 AND IsActive = 1 
        ORDER BY PartyName
      `);

    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب العملاء:', err);
    res.status(500).json({ message: 'فشل تحميل العملاء' });
  }
});

// ✅ لوحة التحكم - مصححة
app.get('/api/dashboard', async (req, res) => {
  try {
    const userId = req.query.userId;
    const pool = await connectDB();

    // ✅ الـ input قبل الـ query
    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`
        SELECT 
          (SELECT COUNT(*) FROM Parties WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as newClientsToday,
          (SELECT COUNT(*) FROM SalesOpportunities WHERE StageID NOT IN (6,7)) as openOpportunities,
          (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed') as tasksToday,
          (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'Sale') as salesToday,
          (SELECT COUNT(*) FROM Notifications 
           WHERE RecipientUser = (SELECT Username FROM Users WHERE UserID = @userId)
           AND IsRead = 0) as unreadCount
      `);

    res.json({
      summary: result.recordset[0],
      unreadCount: result.recordset[0]?.unreadCount || 0
    });
  } catch (err) {
    console.error('خطأ في الداشبورد:', err);
    res.status(500).json({ message: err.message });
  }
});

// ✅ جلب الإشعارات - أضف هذا الـ endpoint
app.get('/api/notifications', async (req, res) => {
  try {
    const userId = req.query.userId;
    const pool = await connectDB();

    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`
        SELECT 
          NotificationID as id,
          Title as title,
          Message as message,
          NotificationType as type,
          IsRead as is_read,
          FORMAT(CreatedAt, 'yyyy-MM-dd hh:mm tt') as created_at
        FROM Notifications 
        WHERE RecipientUser = (SELECT Username FROM Users WHERE UserID = @userId)
        ORDER BY CreatedAt DESC
      `);

    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب الإشعارات:', err);
    res.status(500).json({ message: err.message });
  }
});

// ✅ تحديث إشعار كمقروء
app.put('/api/notifications/:id/read', async (req, res) => {
  try {
    const notificationId = req.params.id;
    const pool = await connectDB();

    await pool.request()
      .input('id', sql.Int, notificationId)
      .query(`
        UPDATE Notifications 
        SET IsRead = 1, ReadAt = GETDATE() 
        WHERE NotificationID = @id
      `);

    res.json({ success: true });
  } catch (err) {
    console.error('خطأ في تحديث الإشعار:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================================
// 📦 المنتجات - Products APIs
// ==========================================

// جلب مجموعات المنتجات (للفلتر)
app.get('/api/product-groups', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT ProductGroupID, GroupName 
        FROM ProductGroups 
        ORDER BY GroupName
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب المجموعات:', err);
    res.status(500).json({ message: err.message });
  }
});

// جلب المنتجات مع البحث والفلتر
app.get('/api/products', async (req, res) => {
  try {
    const { search, groupId } = req.query;
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
        pg.ProductGroupID,
        pg.GroupName,
        pa.PartyName AS CustomerName,
        (SELECT TOP 1 CAST(ImageProduct AS VARBINARY(MAX)) 
         FROM ProductImages 
         WHERE ProductID = p.ProductID) AS ProductImage
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
    
    // تحويل الصور لـ Base64
    const products = result.recordset.map(product => ({
      ...product,
      ProductImage: product.ProductImage 
        ? Buffer.from(product.ProductImage).toString('base64')
        : null
    }));
    
    res.json(products);
  } catch (err) {
    console.error('خطأ في جلب المنتجات:', err);
    res.status(500).json({ message: err.message });
  }
});

// جلب منتج واحد مع كل تفاصيله
app.get('/api/products/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    
    // بيانات المنتج
    const productResult = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT 
          p.*,
          pg.GroupName,
          pa.PartyName AS CustomerName
        FROM Products p
        INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
        LEFT JOIN Parties pa ON p.Customer = pa.PartyID
        WHERE p.ProductID = @id
      `);
    
    if (productResult.recordset.length === 0) {
      return res.status(404).json({ message: 'المنتج غير موجود' });
    }
    
    // صور المنتج
    const imagesResult = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT ProductImagesID, ImageNote,
               CAST(ImageProduct AS VARBINARY(MAX)) AS ImageProduct
        FROM ProductImages 
        WHERE ProductID = @id
      `);
    
    // مكونات المنتج
    const componentsResult = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT ComponentID, ComponentName, Quantity
        FROM ProductComponents 
        WHERE ProductID = @id
      `);
    
    const product = productResult.recordset[0];
    
    res.json({
      ...product,
      images: imagesResult.recordset.map(img => ({
        id: img.ProductImagesID,
        note: img.ImageNote,
        image: img.ImageProduct ? Buffer.from(img.ImageProduct).toString('base64') : null
      })),
      components: componentsResult.recordset
    });
  } catch (err) {
    console.error('خطأ في جلب المنتج:', err);
    res.status(500).json({ message: err.message });
  }
});

// إضافة منتج جديد
app.post('/api/products', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      productName,
      productDescription,
      manufacturingDescription,
      productGroupId,
      customerId,
      purchasePrice,
      suggestedSalePrice,
      pricingType,
      qty,
      period,
      createdBy
    } = req.body;
    
    const result = await pool.request()
      .input('productName', sql.NVarChar(100), productName)
      .input('productDescription', sql.NVarChar(150), productDescription || '')
      .input('manufacturingDescription', sql.NVarChar(sql.MAX), manufacturingDescription)
      .input('productGroupId', sql.Int, productGroupId)
      .input('customerId', sql.Int, customerId || null)
      .input('purchasePrice', sql.Decimal(18, 2), purchasePrice || 0)
      .input('suggestedSalePrice', sql.Decimal(18, 2), suggestedSalePrice || 0)
      .input('pricingType', sql.NVarChar(50), pricingType)
      .input('qty', sql.Int, qty || 1)
      .input('period', sql.Int, period || 0)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO Products (
          ProductName, ProductDescription, ManufacturingDescription,
          ProductGroupID, Customer, PurchasePrice, SuggestedSalePrice,
          PricingType, QTY, Period, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.ProductID
        VALUES (
          @productName, @productDescription, @manufacturingDescription,
          @productGroupId, @customerId, @purchasePrice, @suggestedSalePrice,
          @pricingType, @qty, @period, @createdBy, GETDATE()
        )
      `);
    
    res.json({ 
      success: true, 
      productId: result.recordset[0].ProductID,
      message: 'تم إضافة المنتج بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة المنتج:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// تعديل منتج
app.put('/api/products/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      productName,
      productDescription,
      manufacturingDescription,
      productGroupId,
      customerId,
      purchasePrice,
      suggestedSalePrice,
      pricingType,
      qty,
      period
    } = req.body;
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('productName', sql.NVarChar(100), productName)
      .input('productDescription', sql.NVarChar(150), productDescription || '')
      .input('manufacturingDescription', sql.NVarChar(sql.MAX), manufacturingDescription)
      .input('productGroupId', sql.Int, productGroupId)
      .input('customerId', sql.Int, customerId || null)
      .input('purchasePrice', sql.Decimal(18, 2), purchasePrice || 0)
      .input('suggestedSalePrice', sql.Decimal(18, 2), suggestedSalePrice || 0)
      .input('pricingType', sql.NVarChar(50), pricingType)
      .input('qty', sql.Int, qty || 1)
      .input('period', sql.Int, period || 0)
      .query(`
        UPDATE Products SET
          ProductName = @productName,
          ProductDescription = @productDescription,
          ManufacturingDescription = @manufacturingDescription,
          ProductGroupID = @productGroupId,
          Customer = @customerId,
          PurchasePrice = @purchasePrice,
          SuggestedSalePrice = @suggestedSalePrice,
          PricingType = @pricingType,
          QTY = @qty,
          Period = @period
        WHERE ProductID = @id
      `);
    
    res.json({ success: true, message: 'تم تعديل المنتج بنجاح' });
  } catch (err) {
    console.error('خطأ في تعديل المنتج:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// إضافة صورة للمنتج
app.post('/api/products/:id/images', async (req, res) => {
  try {
    const pool = await connectDB();
    const { imageBase64, imageNote } = req.body;
    
    // تحويل Base64 إلى Buffer
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    
    await pool.request()
      .input('productId', sql.Int, req.params.id)
      .input('imageProduct', sql.VarBinary(sql.MAX), imageBuffer)
      .input('imageNote', sql.NVarChar(255), imageNote || '')
      .query(`
        INSERT INTO ProductImages (ProductID, ImageProduct, ImagePath, ImageNote, CreatedAt)
        VALUES (@productId, @imageProduct, '', @imageNote, GETDATE())
      `);
    
    res.json({ success: true, message: 'تم إضافة الصورة بنجاح' });
  } catch (err) {
    console.error('خطأ في إضافة الصورة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// حذف صورة
app.delete('/api/product-images/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('DELETE FROM ProductImages WHERE ProductImagesID = @id');
    
    res.json({ success: true, message: 'تم حذف الصورة' });
  } catch (err) {
    console.error('خطأ في حذف الصورة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// إضافة/تعديل مكونات المنتج
app.post('/api/products/:id/components', async (req, res) => {
  try {
    const pool = await connectDB();
    const { components, createdBy } = req.body;
    
    // حذف المكونات القديمة
    await pool.request()
      .input('productId', sql.Int, req.params.id)
      .query('DELETE FROM ProductComponents WHERE ProductID = @productId');
    
    // إضافة المكونات الجديدة
    for (const comp of components) {
      await pool.request()
        .input('productId', sql.Int, req.params.id)
        .input('componentName', sql.NVarChar(100), comp.componentName)
        .input('quantity', sql.Int, comp.quantity)
        .input('createdBy', sql.NVarChar(100), createdBy)
        .query(`
          INSERT INTO ProductComponents (ProductID, ComponentName, Quantity, CreatedBy, CreatedAt)
          VALUES (@productId, @componentName, @quantity, @createdBy, GETDATE())
        `);
    }
    
    res.json({ success: true, message: 'تم حفظ المكونات بنجاح' });
  } catch (err) {
    console.error('خطأ في حفظ المكونات:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// جلب العملاء (للاختيار عند إضافة منتج)
app.get('/api/customers-list', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT PartyID, PartyName, Phone
        FROM Parties 
        WHERE PartyType = 1 AND IsActive = 1
        ORDER BY PartyName
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب العملاء:', err);
    res.status(500).json({ message: err.message });
  }
});

// اختبار سريع للسيرفر
app.get('/', (req, res) => {
  res.json({ 
    message: 'COCOBOLO API شغال بنجاح! 🚀', 
    time: new Date().toISOString() 
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 السيرفر شغال على البورت: ${PORT}`);
});