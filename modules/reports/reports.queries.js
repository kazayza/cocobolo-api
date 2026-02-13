const { sql, connectDB } = require('../../core/database');

// ===================================================
// 🔧 Helper: حساب التواريخ
// ===================================================
function buildDates(filters) {
  const now = new Date();
  const currentStart = filters.dateFrom
    ? new Date(filters.dateFrom)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const currentEnd = filters.dateTo ? new Date(filters.dateTo) : now;

  const diffDays =
    Math.ceil(Math.abs(currentEnd - currentStart) / (1000 * 60 * 60 * 24)) + 1;

  const prevEnd = new Date(currentStart);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - diffDays + 1);

  const fmt = (d) => d.toISOString().split('T')[0];

  return {
    cStart: fmt(currentStart),
    cEnd: fmt(currentEnd),
    pStart: fmt(prevStart),
    pEnd: fmt(prevEnd),
    diffDays,
  };
}

// ===================================================
// 🔧 Helper: بناء فلاتر الموظف والمصدر والمرحلة
// ===================================================
function buildFilters(request, filters, tableAlias = 'o') {
  let where = '';

  if (filters.employeeId) {
    where += ` AND ${tableAlias}.EmployeeID = @empId`;
    request.input('empId', sql.Int, parseInt(filters.employeeId));
  }

  if (filters.sourceId) {
    where += ` AND ${tableAlias}.SourceID = @srcId`;
    request.input('srcId', sql.Int, parseInt(filters.sourceId));
  }

  if (filters.stageId) {
    where += ` AND ${tableAlias}.StageID = @stgId`;
    request.input('stgId', sql.Int, parseInt(filters.stageId));
  }

  return where;
}

// ===================================================
// 1. KPIs الرئيسية مع المقارنة
// ===================================================
async function getKPIs(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);
  request.input('pStart', sql.Date, dates.pStart);
  request.input('pEnd', sql.Date, dates.pEnd);

  const empFilter = filters.employeeId
    ? 'AND o.EmployeeID = @empId'
    : '';
  const srcFilter = filters.sourceId
    ? 'AND o.SourceID = @srcId'
    : '';
  const stgFilter = filters.stageId
    ? 'AND o.StageID = @stgId'
    : '';

  if (filters.employeeId)
    request.input('empId', sql.Int, parseInt(filters.employeeId));
  if (filters.sourceId)
    request.input('srcId', sql.Int, parseInt(filters.sourceId));
  if (filters.stageId)
    request.input('stgId', sql.Int, parseInt(filters.stageId));

  const allFilters = `${empFilter} ${srcFilter} ${stgFilter}`;

  const query = `
    SELECT 
      -- ===== الفترة الحالية =====
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd THEN 1 END) 
        AS currentOpportunities,
      
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
        AND o.StageID = 3 THEN 1 END) 
        AS currentWon,
      
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
        AND o.StageID IN (4,5) THEN 1 END) 
        AS currentLost,

      ISNULL(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
        AND o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) 
        AS currentExpectedRevenue,

      -- الإيراد الفعلي من الفواتير
      ISNULL((
        SELECT SUM(t.GrandTotal) 
        FROM Transactions t 
        INNER JOIN SalesOpportunities o2 ON o2.TransactionID = t.TransactionID
        WHERE o2.IsActive = 1 AND o2.StageID = 3
        AND CAST(o2.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
        AND t.TransactionType = 'Sale'
        ${allFilters.replace(/o\./g, 'o2.')}
      ), 0) AS currentActualRevenue,

      -- المحصل فعلياً
      ISNULL((
        SELECT SUM(py.Amount) 
        FROM Payments py
        INNER JOIN Transactions t ON py.TransactionID = t.TransactionID
        INNER JOIN SalesOpportunities o2 ON o2.TransactionID = t.TransactionID
        WHERE o2.IsActive = 1 AND o2.StageID = 3
        AND CAST(o2.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
        AND t.TransactionType = 'Sale'
        ${allFilters.replace(/o\./g, 'o2.')}
      ), 0) AS currentCollected,

      -- نسبة التحويل
      CASE 
        WHEN COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
          AND o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE ROUND(
          (CAST(COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
            AND o.StageID = 3 THEN 1 END) AS FLOAT) / 
          COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
            AND o.StageID IN (3,4,5) THEN 1 END)) * 100, 1)
      END AS currentConversion,

      -- متوسط وقت الإغلاق
      ISNULL(AVG(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
        AND o.StageID = 3 
        THEN DATEDIFF(DAY, o.FirstContactDate, o.LastUpdatedAt) END), 0) 
        AS currentAvgCloseTime,

      -- ===== الفترة السابقة =====
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd THEN 1 END) 
        AS prevOpportunities,

      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
        AND o.StageID = 3 THEN 1 END) 
        AS prevWon,

      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
        AND o.StageID IN (4,5) THEN 1 END) 
        AS prevLost,

      ISNULL(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
        AND o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) 
        AS prevExpectedRevenue,

      ISNULL((
        SELECT SUM(t.GrandTotal) 
        FROM Transactions t 
        INNER JOIN SalesOpportunities o2 ON o2.TransactionID = t.TransactionID
        WHERE o2.IsActive = 1 AND o2.StageID = 3
        AND CAST(o2.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd
        AND t.TransactionType = 'Sale'
        ${allFilters.replace(/o\./g, 'o2.')}
      ), 0) AS prevActualRevenue,

      CASE 
        WHEN COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
          AND o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE ROUND(
          (CAST(COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
            AND o.StageID = 3 THEN 1 END) AS FLOAT) / 
          COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
            AND o.StageID IN (3,4,5) THEN 1 END)) * 100, 1)
      END AS prevConversion,

      ISNULL(AVG(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
        AND o.StageID = 3 
        THEN DATEDIFF(DAY, o.FirstContactDate, o.LastUpdatedAt) END), 0) 
        AS prevAvgCloseTime,

      -- ===== مصاريف الماركتنج =====
      ISNULL((
        SELECT SUM(ex.Amount) FROM Expenses ex 
        WHERE ex.ExpenseGroupID = 9 
        AND CAST(ex.ExpenseDate AS DATE) BETWEEN @cStart AND @cEnd
      ), 0) AS currentMarketingCost,

      ISNULL((
        SELECT SUM(ex.Amount) FROM Expenses ex 
        WHERE ex.ExpenseGroupID = 9 
        AND CAST(ex.ExpenseDate AS DATE) BETWEEN @pStart AND @pEnd
      ), 0) AS prevMarketingCost,

      -- ===== المهام =====
      (SELECT COUNT(*) FROM CRM_Tasks t 
        WHERE t.IsActive = 1 AND t.Status NOT IN ('Completed','Cancelled') 
        AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE)
        ${filters.employeeId ? "AND t.AssignedTo = @empId" : ""}
      ) AS todayTasks,

      (SELECT COUNT(*) FROM CRM_Tasks t 
        WHERE t.IsActive = 1 AND t.Status NOT IN ('Completed','Cancelled') 
        AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)
        ${filters.employeeId ? "AND t.AssignedTo = @empId" : ""}
      ) AS overdueTasks,

      -- ===== الشكاوى المفتوحة =====
      (SELECT COUNT(*) FROM Complaints c 
        WHERE c.Status IN (1,2)
        ${filters.employeeId ? "AND c.AssignedTo = @empId" : ""}
      ) AS openComplaints,

      -- ===== الفرص الراكدة (7 أيام بدون تفاعل) =====
      (SELECT COUNT(*) FROM SalesOpportunities stg
        WHERE stg.IsActive = 1 AND stg.StageID NOT IN (3,4,5)
        AND NOT EXISTS (
          SELECT 1 FROM CustomerInteractions ci 
          WHERE ci.OpportunityID = stg.OpportunityID 
          AND CAST(ci.InteractionDate AS DATE) >= DATEADD(DAY, -7, CAST(GETDATE() AS DATE))
        )
        AND DATEDIFF(DAY, stg.LastUpdatedAt, GETDATE()) > 7
        ${filters.employeeId ? "AND stg.EmployeeID = @empId" : ""}
      ) AS stagnantOpportunities,

      -- ===== متابعات متأخرة =====
      (SELECT COUNT(*) FROM SalesOpportunities fu
        WHERE fu.IsActive = 1 AND fu.StageID NOT IN (3,4,5)
        AND fu.NextFollowUpDate IS NOT NULL
        AND CAST(fu.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE)
        ${filters.employeeId ? "AND fu.EmployeeID = @empId" : ""}
      ) AS overdueFollowUps

    FROM SalesOpportunities o
    WHERE o.IsActive = 1 ${allFilters}
  `;

  const result = await request.query(query);
  return result.recordset[0];
}

// ===================================================
// 2. قمع المبيعات (Sales Funnel)
// ===================================================
async function getFunnel(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  const extraFilters = buildFilters(request, filters, 'o');

  const query = `
    SELECT 
      ss.StageID,
      ss.StageName,
      ss.StageNameAr,
      ss.StageColor,
      ss.StageOrder,
      COUNT(o.OpportunityID) AS count,
      ISNULL(SUM(o.ExpectedValue), 0) AS totalValue,
      ISNULL(SUM(CASE WHEN o.TransactionID IS NOT NULL 
        THEN (SELECT t.GrandTotal FROM Transactions t WHERE t.TransactionID = o.TransactionID) 
        ELSE 0 END), 0) AS actualValue
    FROM SalesStages ss
    LEFT JOIN SalesOpportunities o 
      ON ss.StageID = o.StageID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${extraFilters}
    WHERE ss.IsActive = 1
    GROUP BY ss.StageID, ss.StageName, ss.StageNameAr, ss.StageColor, ss.StageOrder
    ORDER BY ss.StageOrder
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 3. تحليل المصادر + وقت الإغلاق
// ===================================================
async function getSources(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  const extraFilters = buildFilters(request, filters, 'o');

  const query = `
    SELECT 
      cs.SourceID,
      cs.SourceNameAr AS name,
      cs.SourceIcon AS icon,
      COUNT(o.OpportunityID) AS total,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS won,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lost,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS expectedRevenue,
      ISNULL(SUM(CASE WHEN o.StageID = 3 AND o.TransactionID IS NOT NULL 
        THEN (SELECT t.GrandTotal FROM Transactions t WHERE t.TransactionID = o.TransactionID) 
        ELSE 0 END), 0) AS actualRevenue,
      CASE 
        WHEN COUNT(o.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) 
          / COUNT(o.OpportunityID) * 100, 1)
      END AS conversionRate,
      ISNULL(AVG(CASE WHEN o.StageID = 3 
        THEN DATEDIFF(DAY, o.FirstContactDate, o.LastUpdatedAt) END), 0) AS avgCloseTime
    FROM ContactSources cs
    LEFT JOIN SalesOpportunities o 
      ON cs.SourceID = o.SourceID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${extraFilters}
    WHERE cs.IsActive = 1
    GROUP BY cs.SourceID, cs.SourceNameAr, cs.SourceIcon
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY total DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 4. أنواع الإعلانات
// ===================================================
async function getAdTypes(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  const extraFilters = buildFilters(request, filters, 'o');

  const query = `
    SELECT 
      at.AdTypeID,
      at.AdTypeNameAr AS name,
      COUNT(o.OpportunityID) AS total,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS won,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lost,
      ISNULL(SUM(CASE WHEN o.StageID = 3 AND o.TransactionID IS NOT NULL 
        THEN (SELECT t.GrandTotal FROM Transactions t WHERE t.TransactionID = o.TransactionID) 
        ELSE 0 END), 0) AS actualRevenue,
      CASE 
        WHEN COUNT(o.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) 
          / COUNT(o.OpportunityID) * 100, 1)
      END AS conversionRate
    FROM AdTypes at
    LEFT JOIN SalesOpportunities o 
      ON at.AdTypeID = o.AdTypeID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${extraFilters}
    WHERE at.IsActive = 1
    GROUP BY at.AdTypeID, at.AdTypeNameAr
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY total DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 5. تصنيفات الاهتمام
// ===================================================
async function getCategories(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  const extraFilters = buildFilters(request, filters, 'o');

  const query = `
    SELECT 
      ic.CategoryID,
      ic.CategoryNameAr AS name,
      COUNT(o.OpportunityID) AS total,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS won,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lost,
      ISNULL(SUM(CASE WHEN o.StageID = 3 AND o.TransactionID IS NOT NULL 
        THEN (SELECT t.GrandTotal FROM Transactions t WHERE t.TransactionID = o.TransactionID) 
        ELSE 0 END), 0) AS actualRevenue,
      CASE 
        WHEN COUNT(o.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) 
          / COUNT(o.OpportunityID) * 100, 1)
      END AS conversionRate
    FROM InterestCategories ic
    LEFT JOIN SalesOpportunities o 
      ON ic.CategoryID = o.CategoryID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${extraFilters}
    WHERE ic.IsActive = 1
    GROUP BY ic.CategoryID, ic.CategoryNameAr
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY total DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 6. لوحة الشرف + معدل النشاط
// ===================================================
async function getLeaderboard(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  // حساب عدد أيام العمل في الفترة
  const diffDays = dates.diffDays || 30;

  const srcFilter = filters.sourceId
    ? 'AND o.SourceID = @srcId'
    : '';
  const stgFilter = filters.stageId
    ? 'AND o.StageID = @stgId'
    : '';

  if (filters.sourceId)
    request.input('srcId', sql.Int, parseInt(filters.sourceId));
  if (filters.stageId)
    request.input('stgId', sql.Int, parseInt(filters.stageId));

  const query = `
    SELECT TOP 10
      e.EmployeeID,
      e.FullName,
      
      -- الفرص
      COUNT(o.OpportunityID) AS totalOpportunities,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS wonDeals,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lostDeals,
      
      -- الإيرادات
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS expectedRevenue,
      ISNULL(SUM(CASE WHEN o.StageID = 3 AND o.TransactionID IS NOT NULL 
        THEN (SELECT t.GrandTotal FROM Transactions t WHERE t.TransactionID = o.TransactionID) 
        ELSE 0 END), 0) AS actualRevenue,
      
      -- نسبة التحويل
      CASE 
        WHEN COUNT(CASE WHEN o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) / 
          COUNT(CASE WHEN o.StageID IN (3,4,5) THEN 1 END) * 100, 1)
      END AS conversionRate,
      
      -- متوسط وقت الإغلاق
      ISNULL(AVG(CASE WHEN o.StageID = 3 
        THEN DATEDIFF(DAY, o.FirstContactDate, o.LastUpdatedAt) END), 0) AS avgCloseTime,
      
      -- عدد التفاعلات
      (SELECT COUNT(*) FROM CustomerInteractions ci 
        WHERE ci.EmployeeID = e.EmployeeID 
        AND CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
      ) AS totalInteractions,
      
      -- معدل النشاط اليومي
      ROUND(
        CAST((SELECT COUNT(*) FROM CustomerInteractions ci 
          WHERE ci.EmployeeID = e.EmployeeID 
          AND CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
        ) AS FLOAT) / ${diffDays}, 1
      ) AS dailyActivityRate,
      
      -- المهام المنجزة
      (SELECT COUNT(*) FROM CRM_Tasks t 
        WHERE t.AssignedTo = e.EmployeeID 
        AND t.Status = 'Completed' 
        AND CAST(t.CompletedDate AS DATE) BETWEEN @cStart AND @cEnd
      ) AS completedTasks,

      -- المهام المتأخرة
      (SELECT COUNT(*) FROM CRM_Tasks t 
        WHERE t.AssignedTo = e.EmployeeID 
        AND t.IsActive = 1 AND t.Status NOT IN ('Completed','Cancelled')
        AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)
      ) AS overdueTasks

    FROM Employees e
    LEFT JOIN SalesOpportunities o 
      ON e.EmployeeID = o.EmployeeID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${srcFilter} ${stgFilter}
    WHERE e.Status = N'نشط' AND e.Department = N'المبيعات'
    GROUP BY e.EmployeeID, e.FullName
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY actualRevenue DESC, wonDeals DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 7. أسباب الخسارة
// ===================================================
async function getLostReasons(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  const extraFilters = buildFilters(request, filters, 'o');

  const query = `
    SELECT 
      lr.LostReasonID,
      lr.ReasonNameAr AS name,
      COUNT(o.OpportunityID) AS count,
      ISNULL(SUM(o.ExpectedValue), 0) AS lostValue,
      ROUND(
        CAST(COUNT(o.OpportunityID) AS FLOAT) / 
        NULLIF((
          SELECT COUNT(*) FROM SalesOpportunities o2 
          WHERE o2.StageID IN (4,5) AND o2.IsActive = 1 
          AND CAST(o2.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
        ), 0) * 100, 1
      ) AS percentage
    FROM LostReasons lr
    INNER JOIN SalesOpportunities o 
      ON lr.LostReasonID = o.LostReasonID 
      AND o.StageID IN (4,5) 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${extraFilters}
    WHERE lr.IsActive = 1
    GROUP BY lr.LostReasonID, lr.ReasonNameAr
    ORDER BY count DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 8. الترند (يومي أو شهري حسب الفترة)
// ===================================================
async function getTrend(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  const extraFilters = buildFilters(request, filters, 'o');
  const isMonthly = dates.diffDays > 60;

  let query;

  if (isMonthly) {
    query = `
      SELECT 
        FORMAT(o.CreatedAt, 'yyyy-MM') AS period,
        FORMAT(o.CreatedAt, 'MMM yyyy') AS label,
        COUNT(*) AS totalOpportunities,
        COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS wonDeals,
        COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lostDeals,
        ISNULL(SUM(CASE WHEN o.StageID = 3 AND o.TransactionID IS NOT NULL 
          THEN (SELECT t.GrandTotal FROM Transactions t WHERE t.TransactionID = o.TransactionID) 
          ELSE 0 END), 0) AS revenue
      FROM SalesOpportunities o
      WHERE o.IsActive = 1 
        AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
        ${extraFilters}
      GROUP BY FORMAT(o.CreatedAt, 'yyyy-MM'), FORMAT(o.CreatedAt, 'MMM yyyy')
      ORDER BY period
    `;
  } else {
    query = `
      SELECT 
        CAST(o.CreatedAt AS DATE) AS period,
        FORMAT(o.CreatedAt, 'dd MMM') AS label,
        COUNT(*) AS totalOpportunities,
        COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS wonDeals,
        COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lostDeals,
        ISNULL(SUM(CASE WHEN o.StageID = 3 AND o.TransactionID IS NOT NULL 
          THEN (SELECT t.GrandTotal FROM Transactions t WHERE t.TransactionID = o.TransactionID) 
          ELSE 0 END), 0) AS revenue
      FROM SalesOpportunities o
      WHERE o.IsActive = 1 
        AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
        ${extraFilters}
      GROUP BY CAST(o.CreatedAt AS DATE), FORMAT(o.CreatedAt, 'dd MMM')
      ORDER BY period
    `;
  }

  const result = await request.query(query);
  return { type: isMonthly ? 'monthly' : 'daily', data: result.recordset };
}

// ===================================================
// 9. تحليل التفاعلات
// ===================================================
async function getInteractions(pool, dates, filters) {
  const request1 = pool.request();
  request1.input('cStart', sql.Date, dates.cStart);
  request1.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND ci.EmployeeID = @empId';
    request1.input('empId', sql.Int, parseInt(filters.employeeId));
  }

  const summaryQuery = `
    SELECT 
      COUNT(*) AS totalInteractions,
      COUNT(DISTINCT ci.OpportunityID) AS uniqueOpportunities,
      CASE 
        WHEN COUNT(DISTINCT ci.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(*) AS FLOAT) / COUNT(DISTINCT ci.OpportunityID), 1)
      END AS avgPerOpportunity,
      COUNT(CASE WHEN ci.StageBeforeID <> ci.StageAfterID THEN 1 END) AS stageChanges
    FROM CustomerInteractions ci
    WHERE CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
    ${empFilter}
  `;

  const request2 = pool.request();
  request2.input('cStart', sql.Date, dates.cStart);
  request2.input('cEnd', sql.Date, dates.cEnd);
  if (filters.employeeId)
    request2.input('empId', sql.Int, parseInt(filters.employeeId));

  const byStatusQuery = `
    SELECT 
      cst.StatusNameAr AS name,
      COUNT(*) AS count
    FROM CustomerInteractions ci
    INNER JOIN ContactStatus cst ON ci.StatusID = cst.StatusID
    WHERE CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
    ${empFilter}
    GROUP BY cst.StatusNameAr
    ORDER BY count DESC
  `;

  const request3 = pool.request();
  request3.input('cStart', sql.Date, dates.cStart);
  request3.input('cEnd', sql.Date, dates.cEnd);
  if (filters.employeeId)
    request3.input('empId', sql.Int, parseInt(filters.employeeId));

  const bySourceQuery = `
    SELECT 
      cs.SourceNameAr AS name,
      cs.SourceIcon AS icon,
      COUNT(*) AS count
    FROM CustomerInteractions ci
    INNER JOIN ContactSources cs ON ci.SourceID = cs.SourceID
    WHERE CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
    ${empFilter}
    GROUP BY cs.SourceNameAr, cs.SourceIcon
    ORDER BY count DESC
  `;

  const [summary, byStatus, bySource] = await Promise.all([
    request1.query(summaryQuery),
    request2.query(byStatusQuery),
    request3.query(bySourceQuery),
  ]);

  return {
    summary: summary.recordset[0],
    byStatus: byStatus.recordset,
    bySource: bySource.recordset,
  };
}

// ===================================================
// 10. ملخص المهام
// ===================================================
async function getTasks(pool, dates, filters) {
  const request1 = pool.request();
  request1.input('cStart', sql.Date, dates.cStart);
  request1.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND t.AssignedTo = @empId';
    request1.input('empId', sql.Int, parseInt(filters.employeeId));
  }

  const summaryQuery = `
    SELECT 
      COUNT(*) AS totalTasks,
      COUNT(CASE WHEN t.Status = 'Completed' THEN 1 END) AS completed,
      COUNT(CASE WHEN t.Status = 'Pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN t.Status = 'In Progress' THEN 1 END) AS inProgress,
      COUNT(CASE WHEN t.Status = 'Cancelled' THEN 1 END) AS cancelled,
      COUNT(CASE WHEN t.Status NOT IN ('Completed','Cancelled') 
        AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN 1 END) AS overdue,
      CASE 
        WHEN COUNT(*) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN t.Status = 'Completed' THEN 1 END) AS FLOAT) 
          / COUNT(*) * 100, 1)
      END AS completionRate,
      COUNT(CASE WHEN t.Priority = 'High' THEN 1 END) AS highPriority,
      COUNT(CASE WHEN t.Priority = 'Normal' THEN 1 END) AS normalPriority,
      COUNT(CASE WHEN t.Priority = 'Low' THEN 1 END) AS lowPriority
    FROM CRM_Tasks t
    WHERE t.IsActive = 1 
      AND CAST(t.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
  `;

  const request2 = pool.request();
  request2.input('cStart', sql.Date, dates.cStart);
  request2.input('cEnd', sql.Date, dates.cEnd);
  if (filters.employeeId)
    request2.input('empId', sql.Int, parseInt(filters.employeeId));

  const byTypeQuery = `
    SELECT 
      tt.TaskTypeNameAr AS name,
      COUNT(*) AS total,
      COUNT(CASE WHEN t.Status = 'Completed' THEN 1 END) AS completed
    FROM CRM_Tasks t
    INNER JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
    WHERE t.IsActive = 1 
      AND CAST(t.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    GROUP BY tt.TaskTypeNameAr
    ORDER BY total DESC
  `;

  const [summary, byType] = await Promise.all([
    request1.query(summaryQuery),
    request2.query(byTypeQuery),
  ]);

  return {
    summary: summary.recordset[0],
    byType: byType.recordset,
  };
}

// ===================================================
// 11. المتابعات القادمة والمتأخرة
// ===================================================
async function getFollowUps(pool, filters) {
  const request = pool.request();

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, parseInt(filters.employeeId));
  }

  const query = `
    SELECT TOP 15
      o.OpportunityID,
      p.PartyName AS clientName,
      p.Phone,
      e.FullName AS employeeName,
      ss.StageNameAr AS stageName,
      ss.StageColor,
      o.NextFollowUpDate,
      o.Notes,
      CASE 
        WHEN CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) THEN 'overdue'
        WHEN CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN 'today'
        WHEN CAST(o.NextFollowUpDate AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN 'tomorrow'
        ELSE 'upcoming'
      END AS followUpStatus,
      DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(o.NextFollowUpDate AS DATE)) AS daysUntil
    FROM SalesOpportunities o
    INNER JOIN Parties p ON o.PartyID = p.PartyID
    LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
    INNER JOIN SalesStages ss ON o.StageID = ss.StageID
    WHERE o.IsActive = 1 
      AND o.NextFollowUpDate IS NOT NULL
      AND o.StageID NOT IN (3,4,5)
      AND CAST(o.NextFollowUpDate AS DATE) <= DATEADD(DAY, 7, CAST(GETDATE() AS DATE))
      ${empFilter}
    ORDER BY o.NextFollowUpDate ASC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 12. الفرص الراكدة
// ===================================================
async function getStagnantOpportunities(pool, filters) {
  const request = pool.request();

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, parseInt(filters.employeeId));
  }

  const query = `
    SELECT TOP 15
      o.OpportunityID,
      p.PartyName AS clientName,
      p.Phone,
      e.FullName AS employeeName,
      ss.StageNameAr AS stageName,
      ss.StageColor,
      o.LastUpdatedAt,
      o.LastContactDate,
      DATEDIFF(DAY, ISNULL(o.LastContactDate, o.LastUpdatedAt), GETDATE()) AS daysSinceContact,
      o.ExpectedValue,
      o.Notes,
      (SELECT TOP 1 ci.Summary FROM CustomerInteractions ci 
        WHERE ci.OpportunityID = o.OpportunityID 
        ORDER BY ci.InteractionDate DESC
      ) AS lastInteractionSummary
    FROM SalesOpportunities o
    INNER JOIN Parties p ON o.PartyID = p.PartyID
    LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
    INNER JOIN SalesStages ss ON o.StageID = ss.StageID
    WHERE o.IsActive = 1 
      AND o.StageID NOT IN (3,4,5)
      AND DATEDIFF(DAY, ISNULL(o.LastContactDate, o.LastUpdatedAt), GETDATE()) > 7
      ${empFilter}
    ORDER BY daysSinceContact DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 13. قوائم الفلاتر (Dropdowns)
// ===================================================
async function getFilterLists(pool) {
  const [employees, sources, stages] = await Promise.all([
    pool.request().query(`
      SELECT EmployeeID, FullName 
      FROM Employees 
      WHERE Status = N'نشط' AND Department = N'المبيعات' 
      ORDER BY FullName
    `),
    pool.request().query(`
      SELECT SourceID, SourceNameAr AS name, SourceIcon AS icon 
      FROM ContactSources 
      WHERE IsActive = 1 
      ORDER BY SourceNameAr
    `),
    pool.request().query(`
      SELECT StageID, StageNameAr AS name, StageColor AS color 
      FROM SalesStages 
      WHERE IsActive = 1 
      ORDER BY StageOrder
    `),
  ]);

  return {
    employees: employees.recordset,
    sources: sources.recordset,
    stages: stages.recordset,
  };
}

// ===================================================
// 14. التجميع الرئيسي
// ===================================================
async function getDashboardData(filters = {}) {
  const pool = await connectDB();
  const dates = buildDates(filters);

  const [
    kpi,
    funnel,
    sources,
    adTypes,
    categories,
    leaderboard,
    lostReasons,
    trend,
    interactions,
    tasks,
    followUps,
    stagnant,
    filterLists,
  ] = await Promise.all([
    getKPIs(pool, dates, filters),
    getFunnel(pool, dates, filters),
    getSources(pool, dates, filters),
    getAdTypes(pool, dates, filters),
    getCategories(pool, dates, filters),
    getLeaderboard(pool, dates, filters),
    getLostReasons(pool, dates, filters),
    getTrend(pool, dates, filters),
    getInteractions(pool, dates, filters),
    getTasks(pool, dates, filters),
    getFollowUps(pool, filters),
    getStagnantOpportunities(pool, filters),
    getFilterLists(pool),
  ]);

  return {
    period: {
      from: dates.cStart,
      to: dates.cEnd,
      prevFrom: dates.pStart,
      prevTo: dates.pEnd,
      diffDays: dates.diffDays,
    },
    kpi,
    funnel,
    sources,
    adTypes,
    categories,
    leaderboard,
    lostReasons,
    trend,
    interactions,
    tasks,
    followUps,
    stagnant,
    filterLists,
  };
}

module.exports = {
  getDashboardData,
};