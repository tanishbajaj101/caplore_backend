import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.mjs";
import { parseLoginRequest } from "../lib/validation.mjs";
import { signToken } from "../lib/jwt.mjs";
import { requireAuth } from "../middleware/auth.mjs";

const DUMMY_PASSWORD_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const authRouter = Router();

authRouter.post("/login", async (request, response) => {
  const login = parseLoginRequest(request.body ?? {});

  if (login.error) {
    return response.status(400).json({ error: login.error });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, name, email, phone_number, password_hash
       FROM app_users
       WHERE username = $1`,
      [login.value.username],
    );

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(
      login.value.password,
      user ? user.password_hash : DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      return response
        .status(401)
        .json({ error: "Invalid username or password." });
    }

    const token = signToken(user);

    return response.status(200).json({
      success: true,
      token,
      user: {
        username: user.username,
        name: user.name,
        email: user.email,
        phone_number: user.phone_number,
      },
    });
  } catch (error) {
    console.error("Could not process login", error);
    return response
      .status(500)
      .json({ error: "Could not log you in. Please try again." });
  }
});

authRouter.post("/changePassword", requireAuth, async (request, response) => {
  const previousPassword =
    typeof request.body?.previousPassword === "string"
      ? request.body.previousPassword
      : typeof request.body?.currentPassword === "string"
        ? request.body.currentPassword
        : "";
  const newPassword =
    typeof request.body?.newPassword === "string" ? request.body.newPassword : "";

  if (previousPassword.length < 1 || previousPassword.length > 200) {
    return response.status(400).json({ error: "Enter your previous password." });
  }

  if (newPassword.length < 8 || newPassword.length > 200) {
    return response
      .status(400)
      .json({ error: "Password must be between 8 and 200 characters." });
  }

  try {
    const result = await pool.query(
      `SELECT password_hash
       FROM app_users
       WHERE id = $1`,
      [request.userId],
    );

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(
      previousPassword,
      user ? user.password_hash : DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      return response.status(401).json({ error: "Previous password is incorrect." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE app_users
       SET password_hash = $1
       WHERE id = $2`,
      [passwordHash, request.userId],
    );

    return response.status(200).json({ success: true });
  } catch (error) {
    console.error("Could not change password", error);
    return response
      .status(500)
      .json({ error: "Could not change your password. Please try again." });
  }
});
