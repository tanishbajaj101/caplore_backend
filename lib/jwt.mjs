import jwt from "jsonwebtoken";

const jwtSecret = process.env.JWT_SECRET;
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "7d";

if (!jwtSecret) {
  console.error("JWT_SECRET is required");
  process.exit(1);
}

export function signToken(user) {
  return jwt.sign({ sub: String(user.id), username: user.username }, jwtSecret, {
    expiresIn: jwtExpiresIn,
  });
}

export function verifyToken(token) {
  return jwt.verify(token, jwtSecret);
}
