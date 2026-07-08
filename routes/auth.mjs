import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.mjs";
import { parseLoginRequest } from "../lib/validation.mjs";
import { signToken } from "../lib/jwt.mjs";

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
