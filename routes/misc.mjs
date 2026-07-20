import { Router } from "express";
import { pool } from "../db/pool.mjs";
import { parseSubmission } from "../lib/validation.mjs";
import { requireAuth } from "../middleware/auth.mjs";

export const miscRouter = Router();

miscRouter.get("/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed", error);
    response.status(503).json({ status: "unavailable" });
  }
});

miscRouter.post("/submissions", async (request, response) => {
  const submission = parseSubmission(request.body ?? {});

  if (submission.error) {
    return response.status(400).json({ error: submission.error });
  }

  try {
    const result = await pool.query(
      `INSERT INTO form_submissions (name, email, phone)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [
        submission.value.name,
        submission.value.email,
        submission.value.phone,
      ],
    );

    return response.status(201).json({
      success: true,
      submission: result.rows[0],
    });
  } catch (error) {
    console.error("Could not save form submission", error);
    return response
      .status(500)
      .json({ error: "Could not save your details. Please try again." });
  }
});



miscRouter.get("/caplore-ai-news-feed", requireAuth, async (req, res) => {
  // Parse category filter: if not provided or empty, default to null (meaning show all / latest ones)
  const category = (req.query.category && typeof req.query.category === "string" && req.query.category.trim() !== "")
    ? req.query.category.trim()
    : null;

  // Default value for page is 1
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 20;

  // Default value for order/sort is DESC
  let sortOrder = "DESC";
  const orderQuery = req.query.order || req.query.sort;
  if (orderQuery && typeof orderQuery === "string") {
    const normalized = orderQuery.toUpperCase();
    if (normalized === "ASC" || normalized === "DESC") {
      sortOrder = normalized;
    }
  }

  try {
    // 1. Fetch total count of briefs to check if the database/table is empty overall
    const overallCountResult = await pool.query("SELECT COUNT(*)::int AS total FROM ai_daily_briefs");
    const overallTotal = overallCountResult.rows[0]?.total ?? 0;

    if (overallTotal === 0) {
      return res.status(404).json({
        success: false,
        error: "No AI daily briefs found. The database is empty.",
      });
    }

    // 2. Fetch total count of briefs for the filtered category
    const filteredCountResult = await pool.query(
      "SELECT COUNT(*)::int AS total FROM ai_daily_briefs WHERE ($1::text IS NULL OR category = $1)",
      [category]
    );
    const totalBriefs = filteredCountResult.rows[0]?.total ?? 0;

    // Calculate total pages and adjust targeted page if it exceeds the maximum page
    const totalPages = totalBriefs > 0 ? Math.ceil(totalBriefs / limit) : 1;
    const targetPage = Math.min(page, totalPages);
    const offset = (targetPage - 1) * limit;

    // 3. Query the paginated, sorted, and filtered briefs
    const briefsResult = await pool.query(
      `SELECT article_id, category, heading, sentiment, summary, impact, detailed_brief, created_at, updated_at, published_date
       FROM ai_daily_briefs
       WHERE ($3::text IS NULL OR category = $3)
       ORDER BY COALESCE(published_date, created_at) ${sortOrder}
       LIMIT $1 OFFSET $2`,
      [limit, offset, category]
    );

    return res.status(200).json({
      success: true,
      page: targetPage,
      requestedPage: page,
      limit,
      totalBriefs,
      totalPages,
      categoryFilter: category,
      briefs: briefsResult.rows,
    });
  } catch (error) {
    console.error("Error in /caplore-ai-news-feed route:", error);
    return res.status(500).json({
      success: false,
      error: "An error occurred while fetching the AI daily briefs.",
    });
  }
});