import { verifyToken } from "../lib/jwt.mjs";

export function requireAuth(request, response, next) {
  const header = request.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/.exec(header);

  if (!match) {
    return response.status(401).json({ error: "Missing or invalid authorization header." });
  }

  try {
    const payload = verifyToken(match[1]);
    request.userId = Number(payload.sub);
    request.username = payload.username;
    return next();
  } catch {
    return response.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}
