import express from "express";
import { pool } from "./db/pool.mjs";
import { initializeDatabase } from "./db/schema.mjs";
import { corsMiddleware } from "./middleware/cors.mjs";
import { miscRouter } from "./routes/misc.mjs";
import { authRouter } from "./routes/auth.mjs";
import { communityRouter } from "./routes/community.mjs";

const port = Number(process.env.PORT) || 3000;

const app = express();
app.disable("x-powered-by");
app.use("/api", corsMiddleware);
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.use("/api", miscRouter);
app.use("/api", authRouter);
app.use("/api/community", communityRouter);

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "Not found." });
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(port, "0.0.0.0", () => {
      console.log(`Server listening on port ${port}`);
    });
  } catch (error) {
    console.error("Could not initialize PostgreSQL", error);
    process.exit(1);
  }
}

async function shutdown() {
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start();
