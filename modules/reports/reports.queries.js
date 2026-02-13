// reports.queries.js
const { sql, connectDB } = require('../../core/database');

// ===================================================
// 🔹 Helper: إنشاء Request جديد مع الفلاتر المشتركة
// ===================================================
function buildDateParams(pool, filters) {
  const now = new Date();
  const currentStart = filters.dateFrom ? new Date(filters.dateFrom) : new Date(now.getFullYear(), now.getMonth(), 1);
  const currentEnd = filters.dateTo ? new Date(filters.dateTo) : now;

  const diffDays = Math.ceil(Math.abs(currentEnd - currentStart) / (1000 * 60 * 60 * 24)) + 1;
  const prevEnd = new Date(currentStart);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - diffDays + 1);

  const fmt = d => d.toISOString().split('T')[0];

  return {
    cStart: fmt(currentStart),
    cEnd: fmt(currentEnd),
    pStart: fmt(prevStart),
    pEnd: fmt(prevEnd),
  };
}

// ===================================================
// 🔹 1. KPIs الرئيسية مع المقارنة
// ===================================================
async function getKPIs(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);
  request.input('pStart', sql.Date, dates.pStart);
  request.input('pEnd', sql.Date, dates.pEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      -- ===== الفترة الحالية =====
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd THEN 1 END) 
        AS currentOpportunities,
      
      ISNULL(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd AND o.StageID = 3 
        THEN o.ExpectedValue ELSE 0 END), 0) 
        AS currentRevenue,
      
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd AND o.StageID = 3 THEN 1 END) 
        AS currentWon,
      
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd AND o.StageID IN (4,5) THEN 1 END) 
        AS currentLost,

      -- نسبة التحويل الحالية
      CASE 
        WHEN COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
          AND o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE ROUND(
          (CAST(COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
            AND o.StageID = 3 THEN 1 END) AS FLOAT) / 
          COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd 
            AND o.StageID IN (3,4,5) THEN 1 END)) * 100, 1)
      END AS currentConversion,

      -- متوسط وقت الإغلاق (بالأيام) - الفترة الحالية
      ISNULL(AVG(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd AND o.StageID = 3 
        THEN DATEDIFF(DAY, o.FirstContactDate, o.LastUpdatedAt) END), 0) 
        AS currentAvgCloseTime,

      -- ===== الفترة السابقة =====
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd THEN 1 END) 
        AS prevOpportunities,
      
      ISNULL(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd AND o.StageID = 3 
        THEN o.ExpectedValue ELSE 0 END), 0) 
        AS prevRevenue,
      
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd AND o.StageID = 3 THEN 1 END) 
        AS prevWon,

      CASE 
        WHEN COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
          AND o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE ROUND(
          (CAST(COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
            AND o.StageID = 3 THEN 1 END) AS FLOAT) / 
          COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd 
            AND o.StageID IN (3,4,5) THEN 1 END)) * 100, 1)
      END AS prevConversion,

      ISNULL(AVG(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN @pStart AND @pEnd AND o.StageID = 3 
        THEN DATEDIFF(DAY, o.FirstContactDate, o.LastUpdatedAt) END), 0) 
        AS prevAvgCloseTime,

      -- ===== المهام =====
      (SELECT COUNT(*) FROM CRM_Tasks t 
        WHERE t.IsActive = 1 AND t.Status NOT IN ('Completed','Cancelled') 
        AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE)
        ${filters.employeeId ? 'AND t.AssignedTo = @empId' : ''}
      ) AS todayTasks,

      (SELECT COUNT(*) FROM CRM_Tasks t 
        WHERE t.IsActive = 1 AND t.Status NOT IN ('Completed','Cancelled') 
        AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)
        ${filters.employeeId ? 'AND t.AssignedTo = @empId' : ''}
      ) AS overdueTasks,

      -- ===== الشكاوى المفتوحة =====
      (SELECT COUNT(*) FROM Complaints c 
        WHERE c.Status IN (1,2) 
        ${filters.employeeId ? 'AND c.AssignedTo = @empId' : ''}
      ) AS openComplaints

    FROM SalesOpportunities o
    WHERE o.IsActive = 1 ${empFilter}
  `;

  const result = await request.query(query);
  return result.recordset[0];
}

// ===================================================
// 🔹 2. قمع المبيعات (Sales Funnel)
// ===================================================
async function getFunnel(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      ss.StageID,
      ss.StageName,
      ss.StageNameAr,
      ss.StageColor,
      ss.StageOrder,
      COUNT(o.OpportunityID) AS count,
      ISNULL(SUM(o.ExpectedValue), 0) AS totalValue
    FROM SalesStages ss
    LEFT JOIN SalesOpportunities o 
      ON ss.StageID = o.StageID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    WHERE ss.IsActive = 1
    GROUP BY ss.StageID, ss.StageName, ss.StageNameAr, ss.StageColor, ss.StageOrder
    ORDER BY ss.StageOrder
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 3. تحليل المصادر (Sources Analysis)
// ===================================================
async function getSources(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      cs.SourceID,
      cs.SourceNameAr AS name,
      cs.SourceIcon AS icon,
      COUNT(o.OpportunityID) AS total,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS won,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lost,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS revenue,
      CASE 
        WHEN COUNT(o.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) / COUNT(o.OpportunityID) * 100, 1)
      END AS conversionRate
    FROM ContactSources cs
    LEFT JOIN SalesOpportunities o 
      ON cs.SourceID = o.SourceID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    WHERE cs.IsActive = 1
    GROUP BY cs.SourceID, cs.SourceNameAr, cs.SourceIcon
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY total DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 4. تحليل أنواع الإعلانات
// ===================================================
async function getAdTypes(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      at.AdTypeID,
      at.AdTypeNameAr AS name,
      COUNT(o.OpportunityID) AS total,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS won,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS revenue,
      CASE 
        WHEN COUNT(o.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) / COUNT(o.OpportunityID) * 100, 1)
      END AS conversionRate
    FROM AdTypes at
    LEFT JOIN SalesOpportunities o 
      ON at.AdTypeID = o.AdTypeID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    WHERE at.IsActive = 1
    GROUP BY at.AdTypeID, at.AdTypeNameAr
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY total DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 5. لوحة الشرف (Employee Leaderboard)
// ===================================================
async function getLeaderboard(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  const query = `
    SELECT TOP 10
      e.EmployeeID,
      e.FullName,
      COUNT(o.OpportunityID) AS totalOpportunities,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS wonDeals,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lostDeals,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS totalRevenue,
      CASE 
        WHEN COUNT(CASE WHEN o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) / 
          COUNT(CASE WHEN o.StageID IN (3,4,5) THEN 1 END) * 100, 1)
      END AS conversionRate,
      ISNULL(AVG(CASE WHEN o.StageID = 3 
        THEN DATEDIFF(DAY, o.FirstContactDate, o.LastUpdatedAt) END), 0) AS avgCloseTime,
      -- عدد التفاعلات
      (SELECT COUNT(*) FROM CustomerInteractions ci 
        WHERE ci.EmployeeID = e.EmployeeID 
        AND CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
      ) AS totalInteractions,
      -- عدد المهام المنجزة
      (SELECT COUNT(*) FROM CRM_Tasks t 
        WHERE t.AssignedTo = e.EmployeeID 
        AND t.Status = 'Completed' 
        AND CAST(t.CompletedDate AS DATE) BETWEEN @cStart AND @cEnd
      ) AS completedTasks
    FROM Employees e
    LEFT JOIN SalesOpportunities o 
      ON e.EmployeeID = o.EmployeeID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
    WHERE e.Status = N'نشط' AND e.Department = N'المبيعات'
    GROUP BY e.EmployeeID, e.FullName
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY totalRevenue DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 6. أسباب الخسارة (Lost Reasons)
// ===================================================
async function getLostReasons(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      lr.LostReasonID,
      lr.ReasonNameAr AS name,
      COUNT(o.OpportunityID) AS count,
      ISNULL(SUM(o.ExpectedValue), 0) AS lostValue,
      ROUND(CAST(COUNT(o.OpportunityID) AS FLOAT) / 
        NULLIF((SELECT COUNT(*) FROM SalesOpportunities o2 
          WHERE o2.StageID IN (4,5) AND o2.IsActive = 1 
          AND CAST(o2.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
          ${empFilter.replace('o.', 'o2.')}
        ), 0) * 100, 1) AS percentage
    FROM LostReasons lr
    LEFT JOIN SalesOpportunities o 
      ON lr.LostReasonID = o.LostReasonID 
      AND o.StageID IN (4,5) 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    WHERE lr.IsActive = 1
    GROUP BY lr.LostReasonID, lr.ReasonNameAr
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY count DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 7. الترند الشهري (Monthly Trend)
// ===================================================
async function getMonthlyTrend(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      FORMAT(o.CreatedAt, 'yyyy-MM') AS month,
      FORMAT(o.CreatedAt, 'MMM yyyy') AS monthLabel,
      COUNT(*) AS totalOpportunities,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS wonDeals,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lostDeals,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS revenue
    FROM SalesOpportunities o
    WHERE o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    GROUP BY FORMAT(o.CreatedAt, 'yyyy-MM'), FORMAT(o.CreatedAt, 'MMM yyyy')
    ORDER BY month
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 8. الترند اليومي (Daily Trend) - للفترات القصيرة
// ===================================================
async function getDailyTrend(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      CAST(o.CreatedAt AS DATE) AS date,
      FORMAT(o.CreatedAt, 'dd MMM') AS dateLabel,
      COUNT(*) AS totalOpportunities,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS wonDeals,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS revenue
    FROM SalesOpportunities o
    WHERE o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    GROUP BY CAST(o.CreatedAt AS DATE), FORMAT(o.CreatedAt, 'dd MMM')
    ORDER BY date
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 9. تحليل التفاعلات (Interactions Analysis)
// ===================================================
async function getInteractionsAnalysis(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND ci.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      -- إجمالي التفاعلات
      COUNT(*) AS totalInteractions,
      
      -- التفاعلات حسب حالة التواصل
      COUNT(CASE WHEN ci.StatusID = 1 THEN 1 END) AS status1Count,
      COUNT(CASE WHEN ci.StatusID = 2 THEN 1 END) AS status2Count,
      COUNT(CASE WHEN ci.StatusID = 3 THEN 1 END) AS status3Count,
      COUNT(CASE WHEN ci.StatusID = 4 THEN 1 END) AS status4Count,
      
      -- متوسط التفاعلات لكل فرصة
      CASE 
        WHEN COUNT(DISTINCT ci.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(*) AS FLOAT) / COUNT(DISTINCT ci.OpportunityID), 1)
      END AS avgInteractionsPerOpp,

      -- التفاعلات اللي فيها تقدم (المرحلة اتغيرت)
      COUNT(CASE WHEN ci.StageBeforeID <> ci.StageAfterID THEN 1 END) AS stageChanges

    FROM CustomerInteractions ci
    WHERE CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
    ${empFilter}
  `;

  // التفاعلات حسب المصدر
  const bySourceQuery = `
    SELECT 
      cs.SourceNameAr AS name,
      cs.SourceIcon AS icon,
      COUNT(*) AS count
    FROM CustomerInteractions ci
    JOIN ContactSources cs ON ci.SourceID = cs.SourceID
    WHERE CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
    ${empFilter}
    GROUP BY cs.SourceNameAr, cs.SourceIcon
    ORDER BY count DESC
  `;

  // التفاعلات حسب حالة التواصل
  const byStatusQuery = `
    SELECT 
      cst.StatusNameAr AS name,
      COUNT(*) AS count
    FROM CustomerInteractions ci
    JOIN ContactStatus cst ON ci.StatusID = cst.StatusID
    WHERE CAST(ci.InteractionDate AS DATE) BETWEEN @cStart AND @cEnd
    ${empFilter}
    GROUP BY cst.StatusNameAr
    ORDER BY count DESC
  `;

  const [summary, bySource, byStatus] = await Promise.all([
    request.query(query),
    pool.request()
      .input('cStart', sql.Date, dates.cStart)
      .input('cEnd', sql.Date, dates.cEnd)
      .query(bySourceQuery),
    pool.request()
      .input('cStart', sql.Date, dates.cStart)
      .input('cEnd', sql.Date, dates.cEnd)
      .query(byStatusQuery),
  ]);

  return {
    summary: summary.recordset[0],
    bySource: bySource.recordset,
    byStatus: byStatus.recordset,
  };
}

// ===================================================
// 🔹 10. تحليل المهام (Tasks Analysis)
// ===================================================
async function getTasksAnalysis(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND t.AssignedTo = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      COUNT(*) AS totalTasks,
      COUNT(CASE WHEN t.Status = 'Completed' THEN 1 END) AS completed,
      COUNT(CASE WHEN t.Status = 'Pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN t.Status = 'In Progress' THEN 1 END) AS inProgress,
      COUNT(CASE WHEN t.Status = 'Cancelled' THEN 1 END) AS cancelled,
      COUNT(CASE WHEN t.Status NOT IN ('Completed','Cancelled') 
        AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN 1 END) AS overdue,
      
      -- نسبة الإنجاز
      CASE 
        WHEN COUNT(*) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN t.Status = 'Completed' THEN 1 END) AS FLOAT) / COUNT(*) * 100, 1)
      END AS completionRate,

      -- حسب الأولوية
      COUNT(CASE WHEN t.Priority = 'High' THEN 1 END) AS highPriority,
      COUNT(CASE WHEN t.Priority = 'Normal' THEN 1 END) AS normalPriority,
      COUNT(CASE WHEN t.Priority = 'Low' THEN 1 END) AS lowPriority
    FROM CRM_Tasks t
    WHERE t.IsActive = 1 
      AND CAST(t.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
  `;

  // المهام حسب النوع
  const byTypeQuery = `
    SELECT 
      tt.TaskTypeNameAr AS name,
      COUNT(*) AS total,
      COUNT(CASE WHEN t.Status = 'Completed' THEN 1 END) AS completed
    FROM CRM_Tasks t
    JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
    WHERE t.IsActive = 1 
      AND CAST(t.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    GROUP BY tt.TaskTypeNameAr
    ORDER BY total DESC
  `;

  const [summary, byType] = await Promise.all([
    request.query(query),
    pool.request()
      .input('cStart', sql.Date, dates.cStart)
      .input('cEnd', sql.Date, dates.cEnd)
      .query(byTypeQuery),
  ]);

  return {
    summary: summary.recordset[0],
    byType: byType.recordset,
  };
}

// ===================================================
// 🔹 11. تصنيفات الاهتمام (Interest Categories)
// ===================================================
async function getInterestCategories(pool, dates, filters) {
  const request = pool.request();
  request.input('cStart', sql.Date, dates.cStart);
  request.input('cEnd', sql.Date, dates.cEnd);

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT 
      ic.CategoryNameAr AS name,
      COUNT(o.OpportunityID) AS total,
      COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS won,
      COUNT(CASE WHEN o.StageID IN (4,5) THEN 1 END) AS lost,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS revenue,
      CASE 
        WHEN COUNT(o.OpportunityID) = 0 THEN 0
        ELSE ROUND(CAST(COUNT(CASE WHEN o.StageID = 3 THEN 1 END) AS FLOAT) / COUNT(o.OpportunityID) * 100, 1)
      END AS conversionRate
    FROM InterestCategories ic
    LEFT JOIN SalesOpportunities o 
      ON ic.CategoryID = o.CategoryID 
      AND o.IsActive = 1 
      AND CAST(o.CreatedAt AS DATE) BETWEEN @cStart AND @cEnd
      ${empFilter}
    WHERE ic.IsActive = 1
    GROUP BY ic.CategoryNameAr
    HAVING COUNT(o.OpportunityID) > 0
    ORDER BY total DESC
  `;

  const result = await request.query(query);
  return result.recordset;
}

// ===================================================
// 🔹 12. قائمة الموظفين (للفلتر)
// ===================================================
async function getSalesEmployees(pool) {
  const query = `
    SELECT e.EmployeeID, e.FullName
    FROM Employees e
    WHERE e.Status = N'نشط' AND e.Department = N'المبيعات'
    ORDER BY e.FullName
  `;
  const result = await pool.request().query(query);
  return result.recordset;
}

// ===================================================
// 🔹 13. المتابعات القادمة (Upcoming Follow-ups)
// ===================================================
async function getUpcomingFollowUps(pool, filters) {
  const request = pool.request();

  let empFilter = '';
  if (filters.employeeId) {
    empFilter = 'AND o.EmployeeID = @empId';
    request.input('empId', sql.Int, filters.employeeId);
  }

  const query = `
    SELECT TOP 10
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
    JOIN Parties p ON o.PartyID = p.PartyID
    LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
    JOIN SalesStages ss ON o.StageID = ss.StageID
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
// 🔹 14. تجميع كل البيانات
// ===================================================
async function getDashboardData(filters = {}) {
  const pool = await connectDB();
  const dates = buildDateParams(pool, filters);

  // حساب الفرق بالأيام لتحديد نوع الترند
  const diffDays = Math.ceil(
    Math.abs(new Date(dates.cEnd) - new Date(dates.cStart)) / (1000 * 60 * 60 * 24)
  ) + 1;

  const [
    kpi,
    funnel,
    sources,
    adTypes,
    leaderboard,
    lostReasons,
    trend,
    interactions,
    tasks,
    categories,
    employees,
    followUps
  ] = await Promise.all([
    getKPIs(pool, dates, filters),
    getFunnel(pool, dates, filters),
    getSources(pool, dates, filters),
    getAdTypes(pool, dates, filters),
    getLeaderboard(pool, dates, filters),
    getLostReasons(pool, dates, filters),
    diffDays > 60 
      ? getMonthlyTrend(pool, dates, filters)
      : getDailyTrend(pool, dates, filters),
    getInteractionsAnalysis(pool, dates, filters),
    getTasksAnalysis(pool, dates, filters),
    getInterestCategories(pool, dates, filters),
    getSalesEmployees(pool),
    getUpcomingFollowUps(pool, filters),
  ]);

  return {
    period: { from: dates.cStart, to: dates.cEnd, prevFrom: dates.pStart, prevTo: dates.pEnd },
    kpi,
    funnel,
    sources,
    adTypes,
    leaderboard,
    lostReasons,
    trend: { type: diffDays > 60 ? 'monthly' : 'daily', data: trend },
    interactions,
    tasks,
    categories,
    employees,
    followUps,
  };
}

module.exports = {
  getDashboardData,
  getSalesEmployees,
};