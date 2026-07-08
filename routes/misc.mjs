import { Router } from "express";
import { pool } from "../db/pool.mjs";
import { parseSubmission } from "../lib/validation.mjs";

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
