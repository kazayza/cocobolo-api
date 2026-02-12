const { sql, connectDB } = require('../../core/database');

async function getDashboardData(filters = {}) {
  const pool = await connectDB();
  const { dateFrom, dateTo, employeeId } = filters;

  // 1. تحديد الفترات (الحالية والسابقة)
  const currentStart = dateFrom ? new Date(dateFrom) : new Date(); // لو مفيش تاريخ، هيفشل فلازم معالجة في الكنترولر
  const currentEnd = dateTo ? new Date(dateTo) : new Date();
  
  // حساب مدة الفترة بالأيام
  const diffTime = Math.abs(currentEnd - currentStart);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; 

  // حساب الفترة السابقة (نفس المدة قبل تاريخ البدء)
  const prevEnd = new Date(currentStart);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - diffDays + 1);

  // تنسيق التواريخ للـ SQL
  const fmt = d => d.toISOString().split('T')[0];
  
  const cStart = fmt(currentStart);
  const cEnd = fmt(currentEnd);
  const pStart = fmt(prevStart);
  const pEnd = fmt(prevEnd);

  // إعداد الفلتر الإضافي (الموظف)
  let empFilter = "";
  const request = pool.request();
  if (employeeId) {
    empFilter = `AND o.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }

  // ==========================================
  // 1. KPIs مع المقارنة
  // ==========================================
  const kpiQuery = `
    SELECT 
      -- الفترة الحالية
      ISNULL(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${cStart}' AND '${cEnd}' AND o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) as currentRevenue,
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${cStart}' AND '${cEnd}' THEN 1 END) as currentOpportunities,
      
      -- الفترة السابقة
      ISNULL(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${pStart}' AND '${pEnd}' AND o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) as prevRevenue,
      COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${pStart}' AND '${pEnd}' THEN 1 END) as prevOpportunities,

      -- نسبة التحويل الحالية
      CASE 
        WHEN COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${cStart}' AND '${cEnd}' AND o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE (CAST(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${cStart}' AND '${cEnd}' AND o.StageID = 3 THEN 1 ELSE 0 END) AS FLOAT) / 
              COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${cStart}' AND '${cEnd}' AND o.StageID IN (3,4,5) THEN 1 END)) * 100
      END as currentConversion,

      -- نسبة التحويل السابقة
      CASE 
        WHEN COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${pStart}' AND '${pEnd}' AND o.StageID IN (3,4,5) THEN 1 END) = 0 THEN 0
        ELSE (CAST(SUM(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${pStart}' AND '${pEnd}' AND o.StageID = 3 THEN 1 ELSE 0 END) AS FLOAT) / 
              COUNT(CASE WHEN CAST(o.CreatedAt AS DATE) BETWEEN '${pStart}' AND '${pEnd}' AND o.StageID IN (3,4,5) THEN 1 END)) * 100
      END as prevConversion

    FROM SalesOpportunities o
    WHERE o.IsActive = 1 ${empFilter}
  `;

  // ... (باقي الاستعلامات Funnel, Sources, Leaderboard زي ما هي بس بفلتر التاريخ الحالي)
  // عشان الكود ميكبرش، هنستخدم نفس الـ Queries القديمة بس نأكد على شرط التاريخ:
  const dateFilter = `AND CAST(o.CreatedAt AS DATE) BETWEEN '${cStart}' AND '${cEnd}'`;

  // 2. Funnel
  const funnelQuery = `
    SELECT ss.StageNameAr as stage, COUNT(o.OpportunityID) as count
    FROM SalesStages ss
    LEFT JOIN SalesOpportunities o ON ss.StageID = o.StageID AND o.IsActive = 1 ${dateFilter} ${empFilter}
    GROUP BY ss.StageNameAr, ss.StageOrder
    ORDER BY ss.StageOrder
  `;

  // 3. Sources
  const sourcesQuery = `
    SELECT TOP 5 cs.SourceNameAr as name, COUNT(o.OpportunityID) as value
    FROM SalesOpportunities o
    JOIN ContactSources cs ON o.SourceID = cs.SourceID
    WHERE o.IsActive = 1 ${dateFilter} ${empFilter}
    GROUP BY cs.SourceNameAr
    ORDER BY value DESC
  `;

  // 4. Leaderboard
  const leaderboardQuery = `
    SELECT TOP 5 e.FullName, 
      COUNT(o.OpportunityID) as totalDeals,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) as totalRevenue
    FROM Employees e
    JOIN SalesOpportunities o ON e.EmployeeID = o.EmployeeID
    WHERE o.IsActive = 1 ${dateFilter}
    GROUP BY e.FullName
    ORDER BY totalRevenue DESC
  `;

  // 5. Lost Reasons
  const lostReasonQuery = `
    SELECT TOP 5 lr.ReasonNameAr as name, COUNT(o.OpportunityID) as value
    FROM SalesOpportunities o
    JOIN LostReasons lr ON o.LostReasonID = lr.LostReasonID
    WHERE o.IsActive = 1 AND o.StageID IN (4, 5) ${dateFilter} ${empFilter}
    GROUP BY lr.ReasonNameAr
    ORDER BY value DESC
  `;

  const [kpi, funnel, sources, leaderboard, lostReasons] = await Promise.all([
    request.query(kpiQuery),
    request.query(funnelQuery),
    request.query(sourcesQuery),
    request.query(leaderboardQuery),
    request.query(lostReasonQuery)
  ]);

  return {
    kpi: kpi.recordset[0],
    funnel: funnel.recordset,
    sources: sources.recordset,
    leaderboard: leaderboard.recordset,
    lostReasons: lostReasons.recordset
  };
}

module.exports = {
  getDashboardData
};