-- ════════════════════════════════════════════════════════════════════════════
-- ⚠️ يجب تشغيل هذا السكربت قبل أن تعمل ميزة مراجعة الخزينة (الأختام) —
--    بدونه يفشل الختم برسالة واضحة وتتدهور القراءات بأمان.
-- أختام مراجعة الخزينة — dbo.CashBoxReviews
--
-- مراجعة الخزينة (شاشة /cashbox/review) تحفظ «ختم مراجعة» خفيفًا لكل
-- (خزينة، فترة): من راجع ومتى وملاحظته، مع بصمة الفترة وقت الختم
-- (عدد الحركات + إجمالي الوارد + إجمالي الصادر + أحدث وقت إنشاء حركة).
-- الشاشة تقارن البصمة المخزنة بالبيانات الحية فتكشف أي تغيير لاحق داخل
-- فترة مختومة («تغيّرت بعد المراجعة») — كشف فقط: لا يوجد أي قفل أو منع
-- تعديل، والإقفال المحاسبي مؤجل وخارج نطاق هذا السكربت تمامًا.
--
--   • كل ختم صف جديد؛ الأحدث لنفس (الخزينة، من، إلى) هو الحالة الفعالة،
--     والتاريخ كله محفوظ.
--   • PeriodFrom/PeriodTo تواريخ فقط (DATE) — الفترة شاملة الطرفين.
--
-- ⚠️ ترتيب التطبيق:
--    1) هذا السكربت.
--    2) نشر الكود — الكود يتحمل غياب الجدول بتدهور آمن في القراءات
--       (الأرقام والمساعدات تعمل، والأختام معطلة) ورسالة واضحة عند
--       محاولة الختم، لكن الختم نفسه يتطلب الجدول.
--
-- السكربت آمن للتشغيل المتكرر (IF NOT EXISTS على الجدول والفهرس).
-- ⚠️ كل إنشاء مفصول عما يليه بـ GO — لأن SQL Server يترجم الدفعة كاملة قبل
--    تنفيذها، والإشارة لجدول جديد في نفس دفعة إنشائه تُسقط السكربت كله.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── جدول أختام مراجعة الخزينة ─────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.tables
               WHERE name = 'CashBoxReviews' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE dbo.CashBoxReviews
    (
        Id                 INT IDENTITY(1,1) NOT NULL
                           CONSTRAINT PK_CashBoxReviews PRIMARY KEY,
        CashBoxId          INT NOT NULL
                           CONSTRAINT FK_CashBoxReviews_CashBoxes
                           FOREIGN KEY REFERENCES dbo.CashBoxes (CashBoxID),
        PeriodFrom         DATE NOT NULL,               -- بداية الفترة المراجعة (شاملة)
        PeriodTo           DATE NOT NULL,               -- نهاية الفترة المراجعة (شاملة)
        ReviewedByUserName NVARCHAR(256) NOT NULL,      -- اسم مستخدم المراجع
        ReviewedByName     NVARCHAR(256) NULL,          -- لقطة الاسم المعروض وقت الختم
        ReviewedAt         DATETIME2 NOT NULL
                           CONSTRAINT DF_CashBoxReviews_ReviewedAt DEFAULT (SYSDATETIME()),
        Note               NVARCHAR(1000) NULL,         -- ملاحظة اختيارية من المراجع
        TxCount            INT NOT NULL,                -- بصمة: عدد حركات الفترة وقت الختم
        TotalIn            DECIMAL(18,2) NOT NULL,      -- بصمة: إجمالي الوارد وقت الختم
        TotalOut           DECIMAL(18,2) NOT NULL,      -- بصمة: إجمالي الصادر وقت الختم
        LastTxCreatedAt    DATETIME2 NULL,              -- بصمة: أحدث وقت إنشاء حركة وقت الختم
        CONSTRAINT CK_CashBoxReviews_Period CHECK (PeriodFrom <= PeriodTo)
    );
END
GO

-- ─── الفهرس: أحدث ختم لفترة خزينة + قائمة الأختام الأخيرة ──────────────────
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_CashBoxReviews_Box_Period_ReviewedAt'
                 AND object_id = OBJECT_ID('dbo.CashBoxReviews'))
BEGIN
    CREATE INDEX IX_CashBoxReviews_Box_Period_ReviewedAt
        ON dbo.CashBoxReviews (CashBoxId, PeriodFrom, PeriodTo, ReviewedAt DESC);
END
GO

-- ─── التحقق (المتوقع بعد أول تشغيل: 1 · 12 · 1 · 0) ────────────────────────
--     جداول = 1، أعمدة = 12، فهرس البصمة = 1، صفوف = 0
SELECT COUNT(*) AS TablesCreated
FROM sys.tables
WHERE name = 'CashBoxReviews' AND schema_id = SCHEMA_ID('dbo');
GO

SELECT COUNT(*) AS ColumnsCreated
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.CashBoxReviews');
GO

SELECT COUNT(*) AS StampIndexCreated
FROM sys.indexes
WHERE name = 'IX_CashBoxReviews_Box_Period_ReviewedAt'
  AND object_id = OBJECT_ID('dbo.CashBoxReviews');
GO

SELECT COUNT(*) AS ReviewRows FROM dbo.CashBoxReviews;
GO
