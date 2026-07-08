import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db/pool.mjs";

const adminPasswordHash = process.env.ADMIN_DASHBOARD_PASSWORD_HASH || "";
const adminJwtSecret = process.env.ADMIN_JWT_SECRET || "";
const adminJwtExpiresIn = process.env.ADMIN_JWT_EXPIRES_IN || "8h";

export const adminRouter = Router();

function normalizeUserBody(body, { requirePassword = false } = {}) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phoneNumber = typeof body.phone_number === "string" ? body.phone_number.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (username.length < 1 || username.length > 40) {
    return { error: "Enter a username between 1 and 40 characters." };
  }

  if (name.length < 2 || name.length > 120) {
    return { error: "Enter a name between 2 and 120 characters." };
  }

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }

  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    return { error: "Enter a valid international phone number." };
  }

  if ((requirePassword || password) && (password.length < 1 || password.length > 200)) {
    return { error: "Enter a password between 1 and 200 characters." };
  }

  return { value: { username, name, email, phoneNumber, password } };
}

function signAdminToken() {
  return jwt.sign({ role: "admin" }, adminJwtSecret, {
    audience: "caplore-admin",
    expiresIn: adminJwtExpiresIn,
    subject: "admin",
  });
}

function requireAdmin(request, response, next) {
  if (!ensureAdminConfigured(response)) return;

  const header = request.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/.exec(header);

  if (!match) {
    return response.status(401).json({ error: "Missing or invalid authorization header." });
  }

  try {
    const payload = jwt.verify(match[1], adminJwtSecret, {
      audience: "caplore-admin",
    });

    if (payload.role !== "admin") {
      return response.status(403).json({ error: "Admin access is required." });
    }

    return next();
  } catch {
    return response.status(401).json({ error: "Invalid or expired admin session." });
  }
}

function ensureAdminConfigured(response) {
  if (!adminPasswordHash || !adminJwtSecret) {
    response.status(503).json({
      error: "Backend admin auth is missing ADMIN_DASHBOARD_PASSWORD_HASH or ADMIN_JWT_SECRET.",
    });
    return false;
  }

  return true;
}

adminRouter.post("/admin/session", async (request, response) => {
  if (!ensureAdminConfigured(response)) return;

  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!password || password.length > 200) {
    return response.status(400).json({ error: "Enter the admin password." });
  }

  try {
    const passwordMatches = await bcrypt.compare(password, adminPasswordHash);

    if (!passwordMatches) {
      return response.status(401).json({ error: "Invalid admin password." });
    }

    return response.status(200).json({
      success: true,
      token: signAdminToken(),
    });
  } catch (error) {
    console.error("Could not process admin login", error);
    return response.status(500).json({ error: "Could not sign in." });
  }
});

adminRouter.use("/admin", requireAdmin);

adminRouter.get("/admin/users", async (_request, response) => {
  try {
    const result = await pool.query(
      `SELECT username, name, email, phone_number, created_at
       FROM app_users
       ORDER BY created_at DESC, username ASC`,
    );

    return response.status(200).json({ users: result.rows });
  } catch (error) {
    console.error("Could not list admin users", error);
    return response.status(500).json({ error: "Could not load users." });
  }
});

adminRouter.post("/admin/users", async (request, response) => {
  const parsed = normalizeUserBody(request.body ?? {}, { requirePassword: true });
  if (parsed.error) return response.status(400).json({ error: parsed.error });

  const user = parsed.value;

  try {
    const passwordHash = await bcrypt.hash(user.password, 10);
    const result = await pool.query(
      `INSERT INTO app_users (username, name, email, phone_number, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING username, name, email, phone_number, created_at`,
      [user.username, user.name, user.email, user.phoneNumber, passwordHash],
    );

    return response.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({ error: "That username already exists." });
    }

    console.error("Could not create admin user", error);
    return response.status(500).json({ error: "Could not create user." });
  }
});

adminRouter.patch("/admin/users/:username", async (request, response) => {
  const currentUsername = request.params.username;
  const parsed = normalizeUserBody(request.body ?? {});
  if (parsed.error) return response.status(400).json({ error: parsed.error });

  const user = parsed.value;

  try {
    const values = [user.username, user.name, user.email, user.phoneNumber, currentUsername];
    let passwordSql = "";

    if (user.password) {
      values.push(await bcrypt.hash(user.password, 10));
      passwordSql = `, password_hash = $${values.length}`;
    }

    const result = await pool.query(
      `UPDATE app_users
       SET username = $1,
           name = $2,
           email = $3,
           phone_number = $4
           ${passwordSql}
       WHERE username = $5
       RETURNING username, name, email, phone_number, created_at`,
      values,
    );

    if (!result.rowCount) {
      return response.status(404).json({ error: "User not found." });
    }

    return response.status(200).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({ error: "That username already exists." });
    }

    console.error("Could not update admin user", error);
    return response.status(500).json({ error: "Could not update user." });
  }
});

adminRouter.delete("/admin/users/:username", async (request, response) => {
  try {
    const result = await pool.query(
      `DELETE FROM app_users WHERE username = $1`,
      [request.params.username],
    );

    if (!result.rowCount) {
      return response.status(404).json({ error: "User not found." });
    }

    return response.status(200).json({ success: true });
  } catch (error) {
    console.error("Could not delete admin user", error);
    return response.status(500).json({ error: "Could not delete user." });
  }
});
