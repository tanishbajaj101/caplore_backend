import express from "express";
import pg from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const port = Number(process.env.PORT) || 3000;
const databaseUrl = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadRoot = path.join(__dirname, "uploads");
const allowedOrigins = new Set(
  [
    "https://caplore.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.ALLOWED_ORIGINS ?? "").split(","),
  ]
    .map((origin) => origin.trim())
    .filter(Boolean),
);

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_submissions (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(254) NOT NULL,
      phone VARCHAR(16) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(40) UNIQUE NOT NULL,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(254) NOT NULL,
      phone_number VARCHAR(16) NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await seedDummyUsers();
  await initializeCommunitySchema();
  await seedCommunityData();
}

async function initializeCommunitySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_connections (
      id BIGSERIAL PRIMARY KEY,
      requester_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      receiver_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT community_connections_no_self CHECK (requester_id <> receiver_id),
      CONSTRAINT community_connections_status_check CHECK (status IN ('pending', 'accepted', 'rejected'))
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS community_connections_pair_unique
    ON community_connections (LEAST(requester_id, receiver_id), GREATEST(requester_id, receiver_id))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_connections_receiver_status_idx
    ON community_connections (receiver_id, status, updated_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_connections_requester_status_idx
    ON community_connections (requester_id, status, updated_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      body TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_posts_user_created_idx
    ON community_posts (user_id, created_at DESC)
  `);

  await pool.query(`
    ALTER TABLE community_posts
    ADD COLUMN IF NOT EXISTS post_type VARCHAR(24) NOT NULL DEFAULT 'discussion'
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_posts_type_created_idx
    ON community_posts (post_type, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_post_images (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT community_post_images_sort_order_check CHECK (sort_order >= 0)
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS community_post_images_post_sort_unique
    ON community_post_images (post_id, sort_order)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_comments (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT community_comments_body_check CHECK (LENGTH(BTRIM(body)) > 0)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_comments_post_created_idx
    ON community_comments (post_id, created_at ASC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_post_likes (
      post_id BIGINT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_post_likes_user_created_idx
    ON community_post_likes (user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_post_saves (
      post_id BIGINT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_post_saves_user_created_idx
    ON community_post_saves (user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_clubs (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      description VARCHAR(220) NOT NULL,
      privacy VARCHAR(12) NOT NULL DEFAULT 'public',
      icon VARCHAR(12) NOT NULL DEFAULT 'C',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT community_clubs_privacy_check CHECK (privacy IN ('public', 'private'))
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_club_members (
      club_id BIGINT NOT NULL REFERENCES community_clubs(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      status VARCHAR(12) NOT NULL DEFAULT 'accepted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (club_id, user_id),
      CONSTRAINT community_club_members_status_check CHECK (status IN ('accepted', 'pending'))
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS community_club_members_user_status_idx
    ON community_club_members (user_id, status, created_at DESC)
  `);
}

const DUMMY_USERS = [
  {
    username: "alice.chen",
    name: "Alice Chen",
    email: "alice.chen@example.com",
    phoneNumber: "+14155550101",
    password: "Caplore123!",
  },
  {
    username: "bob.martins",
    name: "Bob Martins",
    email: "bob.martins@example.com",
    phoneNumber: "+919845550102",
    password: "Caplore456!",
  },
  {
    username: "carla.singh",
    name: "Carla Singh",
    email: "carla.singh@example.com",
    phoneNumber: "+442075550103",
    password: "Caplore789!",
  },
  {
    username: "dev.mehra",
    name: "Dev Mehra",
    email: "dev.mehra@example.com",
    phoneNumber: "+919845550104",
    password: "Caplore321!",
  },
  {
    username: "fatima.khan",
    name: "Fatima Khan",
    email: "fatima.khan@example.com",
    phoneNumber: "+97155550105",
    password: "Caplore654!",
  },
  {
    username: "neil.patel",
    name: "Neil Patel",
    email: "neil.patel@example.com",
    phoneNumber: "+14155550106",
    password: "Caplore987!",
  },
];

const DUMMY_PASSWORD_HASH = bcrypt.hashSync("not-a-real-password", 10);

async function seedDummyUsers() {
  for (const user of DUMMY_USERS) {
    const passwordHash = await bcrypt.hash(user.password, 10);

    await pool.query(
      `INSERT INTO app_users (username, name, email, phone_number, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO NOTHING`,
      [user.username, user.name, user.email, user.phoneNumber, passwordHash],
    );
  }
}

async function seedCommunityData() {
  const users = await pool.query(
    `SELECT id, username FROM app_users WHERE username = ANY($1::text[])`,
    [DUMMY_USERS.map((user) => user.username)],
  );
  const userIds = new Map(users.rows.map((user) => [user.username, user.id]));

  const connections = [
    ["alice.chen", "bob.martins", "accepted"],
    ["alice.chen", "carla.singh", "accepted"],
    ["bob.martins", "dev.mehra", "accepted"],
    ["fatima.khan", "alice.chen", "pending"],
    ["neil.patel", "carla.singh", "pending"],
  ];

  for (const [requester, receiver, status] of connections) {
    const requesterId = userIds.get(requester);
    const receiverId = userIds.get(receiver);
    if (!requesterId || !receiverId) continue;

    await pool.query(
      `INSERT INTO community_connections (requester_id, receiver_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [requesterId, receiverId, status],
    );
  }

  const clubs = [
    ["Manufacturing Investors", "Industrial SME and export diligence room", "public", "MI"],
    ["Healthcare & Pharma", "Healthcare, CDMO, diagnostics, and pharma IPO notes", "public", "HP"],
    ["Pre-IPO Deal Hunters", "Active pre-IPO opportunities and pricing debates", "public", "PI"],
    ["Family Office Network", "Private family office allocation discussions", "private", "FO"],
    ["SME IPO Watchers", "SME IPO filings, listing gains, and governance signals", "public", "SM"],
  ];

  for (const [name, description, privacy, icon] of clubs) {
    await pool.query(
      `INSERT INTO community_clubs (name, description, privacy, icon)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [name, description, privacy, icon],
    );
  }

  const clubMemberships = [
    ["alice.chen", "Manufacturing Investors", "accepted"],
    ["alice.chen", "Healthcare & Pharma", "accepted"],
    ["bob.martins", "Pre-IPO Deal Hunters", "accepted"],
    ["carla.singh", "Healthcare & Pharma", "accepted"],
    ["dev.mehra", "SME IPO Watchers", "accepted"],
  ];

  for (const [username, clubName, status] of clubMemberships) {
    const userId = userIds.get(username);
    if (!userId) continue;

    await pool.query(
      `INSERT INTO community_club_members (club_id, user_id, status)
       SELECT id, $2, $3 FROM community_clubs WHERE name = $1
       ON CONFLICT DO NOTHING`,
      [clubName, userId, status],
    );
  }

  const postCount = await pool.query(`SELECT COUNT(*)::int AS count FROM community_posts`);
  if (postCount.rows[0]?.count > 0) return;

  const posts = [
    {
      username: "alice.chen",
      type: "deal_insight",
      body: "Looking at export-oriented engineering SMEs this week. Operating leverage looks powerful, but receivable days are the first thing I am checking.",
    },
    {
      username: "bob.martins",
      type: "question",
      body: "Useful founder call today: the best answers were around customer concentration and working-capital discipline. Those two questions still separate the room.",
    },
    {
      username: "carla.singh",
      type: "market_insight",
      body: "Pharma CDMO pipeline is heating up again. Anyone tracking smaller facilities with USFDA readiness but conservative debt?",
    },
    {
      username: "dev.mehra",
      type: "deal_insight",
      body: "SME IPO pipeline note: I am seeing more profitable manufacturing issuers price below listed peers. Worth watching the next filing cycle.",
    },
  ];

  for (const post of posts) {
    const userId = userIds.get(post.username);
    if (!userId) continue;

    const result = await pool.query(
      `INSERT INTO community_posts (user_id, post_type, body)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, post.type, post.body],
    );
    const postId = result.rows[0].id;

    await pool.query(
      `INSERT INTO community_comments (post_id, user_id, body)
       SELECT $1, id, $3 FROM app_users WHERE username = $2`,
      [postId, post.username === "alice.chen" ? "bob.martins" : "alice.chen", "Strong point. Adding this to my diligence checklist."],
    );
  }
}

async function findUserByUsername(username) {
  const result = await pool.query(
    `SELECT id, username, name, email FROM app_users WHERE username = $1`,
    [username],
  );

  return result.rows[0] ?? null;
}

function parseCommunityUsername(bodyOrQuery) {
  const username =
    typeof bodyOrQuery.username === "string"
      ? bodyOrQuery.username.trim()
      : "";

  if (username.length < 1 || username.length > 40) {
    return { error: "A valid username is required." };
  }

  return { value: username };
}

function initialsForName(name, username) {
  const source = String(name || username || "Investor").trim();
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function parseSubmission(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";

  if (name.length < 2 || name.length > 80) {
    return { error: "Enter a name between 2 and 80 characters." };
  }

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return { error: "Enter a valid email address." };
  }

  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    return { error: "Enter a valid international phone number." };
  }

  return { value: { name, email, phone } };
}

function parseLoginRequest(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (username.length < 1 || username.length > 40) {
    return { error: "Enter your username." };
  }

  if (password.length < 1 || password.length > 200) {
    return { error: "Enter your password." };
  }

  return { value: { username, password } };
}

function parsePostRequest(body) {
  const usernameResult = parseCommunityUsername(body);
  if (usernameResult.error) return { error: usernameResult.error };

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const postType = typeof body.postType === "string" ? body.postType : "discussion";
  const images = Array.isArray(body.images) ? body.images : [];
  const allowedTypes = new Set(["discussion", "deal_insight", "event", "question", "market_insight"]);

  if (!allowedTypes.has(postType)) {
    return { error: "Choose a valid post category." };
  }

  if (text.length > 4000) {
    return { error: "Posts can be up to 4,000 characters." };
  }

  if (images.length > 4) {
    return { error: "Upload up to 4 images per post." };
  }

  if (!text && images.length === 0) {
    return { error: "Add text, an image, or both before sharing." };
  }

  for (const image of images) {
    if (!image || typeof image !== "object") {
      return { error: "Each image must be a valid upload." };
    }

    if (typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/")) {
      return { error: "Only image uploads are supported." };
    }
  }

  return { value: { username: usernameResult.value, postType, text, images } };
}

function parseCommentRequest(body) {
  const usernameResult = parseCommunityUsername(body);
  if (usernameResult.error) return { error: usernameResult.error };

  const postId = Number(body.postId);
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!Number.isSafeInteger(postId) || postId < 1) {
    return { error: "A valid post is required." };
  }

  if (text.length < 1 || text.length > 1200) {
    return { error: "Comments must be between 1 and 1,200 characters." };
  }

  return { value: { username: usernameResult.value, postId, text } };
}

function parseConnectionRequest(body) {
  const usernameResult = parseCommunityUsername(body);
  if (usernameResult.error) return { error: usernameResult.error };

  const receiverUsername =
    typeof body.receiverUsername === "string"
      ? body.receiverUsername.trim()
      : "";

  if (receiverUsername.length < 1 || receiverUsername.length > 40) {
    return { error: "Choose a valid member to connect with." };
  }

  if (receiverUsername === usernameResult.value) {
    return { error: "You cannot connect with yourself." };
  }

  return { value: { username: usernameResult.value, receiverUsername } };
}

function parseConnectionResponse(body) {
  const usernameResult = parseCommunityUsername(body);
  if (usernameResult.error) return { error: usernameResult.error };

  const connectionId = Number(body.connectionId);
  const status = typeof body.status === "string" ? body.status : "";

  if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
    return { error: "A valid connection request is required." };
  }

  if (!["accepted", "rejected"].includes(status)) {
    return { error: "Connection requests can only be accepted or rejected." };
  }

  return { value: { username: usernameResult.value, connectionId, status } };
}

function parseClubMembershipRequest(body, params) {
  const usernameResult = parseCommunityUsername(body);
  if (usernameResult.error) return { error: usernameResult.error };

  const clubId = Number(params.clubId);
  if (!Number.isSafeInteger(clubId) || clubId < 1) {
    return { error: "Choose a valid investor club." };
  }

  return { value: { username: usernameResult.value, clubId } };
}

async function savePostImage(image, sortOrder) {
  const match = image.dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    throw new Error("Images must be PNG, JPG, WEBP, or GIF files.");
  }

  const mimeType = match[1].toLowerCase();
  const extension = mimeType.includes("png")
    ? "png"
    : mimeType.includes("webp")
      ? "webp"
      : mimeType.includes("gif")
        ? "gif"
        : "jpg";
  const buffer = Buffer.from(match[2], "base64");

  if (buffer.length > 4 * 1024 * 1024) {
    throw new Error("Each image must be 4 MB or smaller.");
  }

  const now = new Date();
  const uploadDirectory = path.join(
    uploadRoot,
    "community",
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
  );
  await fs.mkdir(uploadDirectory, { recursive: true });

  const filename = `${Date.now()}-${sortOrder}-${randomUUID()}.${extension}`;
  const absolutePath = path.join(uploadDirectory, filename);
  await fs.writeFile(absolutePath, buffer);

  return `/uploads/community/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${filename}`;
}

const app = express();
app.disable("x-powered-by");
app.use("/api", (request, response, next) => {
  const origin = request.get("origin");

  if (origin && allowedOrigins.has(origin)) {
    response.set("Access-Control-Allow-Origin", origin);
    response.vary("Origin");
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Content-Type");
  }

  if (request.method === "OPTIONS") {
    return origin && allowedOrigins.has(origin)
      ? response.sendStatus(204)
      : response.sendStatus(403);
  }

  return next();
});
app.use("/uploads", express.static(uploadRoot));
app.use(express.json({ limit: "24mb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed", error);
    response.status(503).json({ status: "unavailable" });
  }
});

app.post("/api/submissions", async (request, response) => {
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

app.post("/api/login", async (request, response) => {
  const login = parseLoginRequest(request.body ?? {});

  if (login.error) {
    return response.status(400).json({ error: login.error });
  }

  try {
    const result = await pool.query(
      `SELECT username, name, email, phone_number, password_hash
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

    return response.status(200).json({
      success: true,
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

async function getCommunityPayload(user) {
  const profileStats = await pool.query(
    `SELECT
       COUNT(DISTINCT CASE WHEN c.status = 'accepted' THEN c.id END)::int AS connections,
       COUNT(DISTINCT p.id)::int AS posts,
       COUNT(DISTINCT s.post_id)::int AS saved_posts
     FROM app_users u
     LEFT JOIN community_connections c
       ON c.requester_id = u.id OR c.receiver_id = u.id
     LEFT JOIN community_posts p ON p.user_id = u.id
     LEFT JOIN community_post_saves s ON s.user_id = u.id
     WHERE u.id = $1`,
    [user.id],
  );

  const suggestions = await pool.query(
    `SELECT u.username, u.name, u.email
     FROM app_users u
     WHERE u.id <> $1
       AND NOT EXISTS (
         SELECT 1
         FROM community_connections c
         WHERE LEAST(c.requester_id, c.receiver_id) = LEAST($1, u.id)
           AND GREATEST(c.requester_id, c.receiver_id) = GREATEST($1, u.id)
       )
     ORDER BY u.created_at DESC
     LIMIT 8`,
    [user.id],
  );

  const requests = await pool.query(
    `SELECT c.id, c.created_at, u.username, u.name, u.email
     FROM community_connections c
     JOIN app_users u ON u.id = c.requester_id
     WHERE c.receiver_id = $1 AND c.status = 'pending'
     ORDER BY c.created_at DESC
     LIMIT 8`,
    [user.id],
  );

  const connections = await pool.query(
    `SELECT c.id, c.updated_at, u.username, u.name, u.email
     FROM community_connections c
     JOIN app_users u ON u.id = CASE
       WHEN c.requester_id = $1 THEN c.receiver_id
       ELSE c.requester_id
     END
     WHERE c.status = 'accepted'
       AND (c.requester_id = $1 OR c.receiver_id = $1)
     ORDER BY c.updated_at DESC
     LIMIT 12`,
    [user.id],
  );

  const clubs = await pool.query(
    `SELECT cl.id, cl.name, cl.description, cl.privacy, cl.icon,
            COUNT(cm_all.user_id)::int AS member_count,
            own.status AS membership_status
     FROM community_clubs cl
     LEFT JOIN community_club_members cm_all
       ON cm_all.club_id = cl.id AND cm_all.status = 'accepted'
     LEFT JOIN community_club_members own
       ON own.club_id = cl.id AND own.user_id = $1
     GROUP BY cl.id, own.status
     ORDER BY cl.created_at ASC
     LIMIT 8`,
    [user.id],
  );

  const posts = await pool.query(
    `WITH visible_users AS (
       SELECT $1::bigint AS id
       UNION
       SELECT CASE
         WHEN requester_id = $1 THEN receiver_id
         ELSE requester_id
       END
       FROM community_connections
       WHERE status = 'accepted'
         AND (requester_id = $1 OR receiver_id = $1)
     )
     SELECT p.id, p.body, p.created_at, p.updated_at,
            p.post_type, u.username, u.name,
            COUNT(DISTINCT l.user_id)::int AS like_count,
            COUNT(DISTINCT cm.id)::int AS comment_count,
            BOOL_OR(l.user_id = $1)::boolean AS liked_by_current_user,
            BOOL_OR(s.user_id = $1)::boolean AS saved_by_current_user
     FROM community_posts p
     JOIN app_users u ON u.id = p.user_id
     LEFT JOIN community_post_likes l ON l.post_id = p.id
     LEFT JOIN community_comments cm ON cm.post_id = p.id
     LEFT JOIN community_post_saves s ON s.post_id = p.id
     WHERE p.user_id IN (SELECT id FROM visible_users)
     GROUP BY p.id, p.post_type, u.username, u.name
     ORDER BY p.created_at DESC
     LIMIT 30`,
    [user.id],
  );

  const postIds = posts.rows.map((post) => post.id);
  const images = postIds.length
    ? await pool.query(
        `SELECT post_id, image_path, sort_order
         FROM community_post_images
         WHERE post_id = ANY($1::bigint[])
         ORDER BY post_id, sort_order`,
        [postIds],
      )
    : { rows: [] };
  const comments = postIds.length
    ? await pool.query(
        `SELECT c.id, c.post_id, c.body, c.created_at, u.username, u.name
         FROM community_comments c
         JOIN app_users u ON u.id = c.user_id
         WHERE c.post_id = ANY($1::bigint[])
         ORDER BY c.created_at ASC`,
        [postIds],
      )
    : { rows: [] };

  const imagesByPost = new Map();
  for (const image of images.rows) {
    const list = imagesByPost.get(String(image.post_id)) ?? [];
    list.push(image.image_path);
    imagesByPost.set(String(image.post_id), list);
  }

  const commentsByPost = new Map();
  for (const comment of comments.rows) {
    const list = commentsByPost.get(String(comment.post_id)) ?? [];
    list.push({
      id: comment.id,
      text: comment.body,
      createdAt: comment.created_at,
      author: {
        username: comment.username,
        name: comment.name,
        initials: initialsForName(comment.name, comment.username),
      },
    });
    commentsByPost.set(String(comment.post_id), list);
  }

  const trendingPosts = await pool.query(
    `SELECT p.id, p.body, u.name, u.username,
            (COUNT(DISTINCT l.user_id) * 2 + COUNT(DISTINCT c.id))::int AS score
     FROM community_posts p
     JOIN app_users u ON u.id = p.user_id
     LEFT JOIN community_post_likes l ON l.post_id = p.id
     LEFT JOIN community_comments c ON c.post_id = p.id
     WHERE p.created_at >= NOW() - INTERVAL '30 days'
     GROUP BY p.id, u.name, u.username
     ORDER BY score DESC, p.created_at DESC
     LIMIT 5`,
  );

  return {
    currentUser: {
      username: user.username,
      name: user.name,
      initials: initialsForName(user.name, user.username),
    },
    profileStats: {
      connections: profileStats.rows[0]?.connections ?? 0,
      posts: profileStats.rows[0]?.posts ?? 0,
      investments: 6,
      profileViews: 34,
      postImpressions: 1240,
      savedPosts: profileStats.rows[0]?.saved_posts ?? 0,
    },
    suggestions: suggestions.rows.map((suggestion) => ({
      username: suggestion.username,
      name: suggestion.name,
      email: suggestion.email,
      initials: initialsForName(suggestion.name, suggestion.username),
    })),
    requests: requests.rows.map((connection) => ({
      id: connection.id,
      createdAt: connection.created_at,
      user: {
        username: connection.username,
        name: connection.name,
        email: connection.email,
        initials: initialsForName(connection.name, connection.username),
      },
    })),
    connections: connections.rows.map((connection) => ({
      id: connection.id,
      updatedAt: connection.updated_at,
      username: connection.username,
      name: connection.name,
      email: connection.email,
      initials: initialsForName(connection.name, connection.username),
    })),
    clubs: clubs.rows.map((club) => ({
      id: club.id,
      name: club.name,
      description: club.description,
      privacy: club.privacy,
      icon: club.icon,
      memberCount: club.member_count,
      membershipStatus: club.membership_status ?? "none",
    })),
    posts: posts.rows.map((post) => ({
      id: post.id,
      postType: post.post_type,
      text: post.body ?? "",
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      images: imagesByPost.get(String(post.id)) ?? [],
      likeCount: post.like_count,
      commentCount: post.comment_count,
      likedByCurrentUser: Boolean(post.liked_by_current_user),
      savedByCurrentUser: Boolean(post.saved_by_current_user),
      author: {
        username: post.username,
        name: post.name,
        initials: initialsForName(post.name, post.username),
      },
      comments: commentsByPost.get(String(post.id)) ?? [],
    })),
    trending: [
      { label: "SME IPO pipeline", metric: "27 active filings", tone: "blue" },
      { label: "Engineering exports", metric: "High discussion", tone: "green" },
      { label: "Founder diligence", metric: "18 checklist saves", tone: "amber" },
      ...trendingPosts.rows.slice(0, 2).map((post) => ({
        label: post.body ? `${post.body.slice(0, 48)}${post.body.length > 48 ? "..." : ""}` : `Post by ${post.name}`,
        metric: `${post.score} network score`,
        tone: "purple",
      })),
    ].slice(0, 5),
    events: [
      { title: "Founder AMA: ABC Engineering", date: "22 May", time: "5:00 PM IST", type: "Live room" },
      { title: "SME IPO Pipeline Roundtable", date: "24 May", time: "11:00 AM IST", type: "Webinar" },
      { title: "Investor Networking Meet", date: "5 Jun", time: "6:30 PM IST", type: "Community" },
    ],
  };
}

app.get("/api/community", async (request, response) => {
  const username = parseCommunityUsername(request.query ?? {});
  if (username.error) return response.status(400).json({ error: username.error });

  try {
    const user = await findUserByUsername(username.value);
    if (!user) return response.status(404).json({ error: "User not found." });

    return response.json(await getCommunityPayload(user));
  } catch (error) {
    console.error("Could not load community", error);
    return response.status(500).json({ error: "Could not load community." });
  }
});

app.post("/api/community/posts", async (request, response) => {
  const parsed = parsePostRequest(request.body ?? {});
  if (parsed.error) return response.status(400).json({ error: parsed.error });

  try {
    const user = await findUserByUsername(parsed.value.username);
    if (!user) return response.status(404).json({ error: "User not found." });

    const imagePaths = [];
    for (const [index, image] of parsed.value.images.entries()) {
      imagePaths.push(await savePostImage(image, index));
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const postResult = await client.query(
        `INSERT INTO community_posts (user_id, post_type, body)
         VALUES ($1, $2, NULLIF($3, ''))
         RETURNING id`,
        [user.id, parsed.value.postType, parsed.value.text],
      );
      const postId = postResult.rows[0].id;

      for (const [index, imagePath] of imagePaths.entries()) {
        await client.query(
          `INSERT INTO community_post_images (post_id, image_path, sort_order)
           VALUES ($1, $2, $3)`,
          [postId, imagePath, index],
        );
      }

      await client.query("COMMIT");
      return response.status(201).json({ success: true, postId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Could not create community post", error);
    return response.status(500).json({
      error: error instanceof Error ? error.message : "Could not create post.",
    });
  }
});

app.post("/api/community/comments", async (request, response) => {
  const parsed = parseCommentRequest(request.body ?? {});
  if (parsed.error) return response.status(400).json({ error: parsed.error });

  try {
    const user = await findUserByUsername(parsed.value.username);
    if (!user) return response.status(404).json({ error: "User not found." });

    const result = await pool.query(
      `INSERT INTO community_comments (post_id, user_id, body)
       SELECT $1, $2, $3
       WHERE EXISTS (SELECT 1 FROM community_posts WHERE id = $1)
       RETURNING id, created_at`,
      [parsed.value.postId, user.id, parsed.value.text],
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: "Post not found." });
    }

    return response.status(201).json({ success: true, comment: result.rows[0] });
  } catch (error) {
    console.error("Could not create comment", error);
    return response.status(500).json({ error: "Could not add comment." });
  }
});

app.post("/api/community/connections", async (request, response) => {
  const parsed = parseConnectionRequest(request.body ?? {});
  if (parsed.error) return response.status(400).json({ error: parsed.error });

  try {
    const requester = await findUserByUsername(parsed.value.username);
    const receiver = await findUserByUsername(parsed.value.receiverUsername);
    if (!requester || !receiver) {
      return response.status(404).json({ error: "Member not found." });
    }

    const existing = await pool.query(
      `SELECT id, status
       FROM community_connections
       WHERE LEAST(requester_id, receiver_id) = LEAST($1, $2)
         AND GREATEST(requester_id, receiver_id) = GREATEST($1, $2)`,
      [requester.id, receiver.id],
    );

    if (existing.rows[0]) {
      return response.status(200).json({
        success: true,
        connection: existing.rows[0],
      });
    }

    const result = await pool.query(
      `INSERT INTO community_connections (requester_id, receiver_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING id, status, created_at`,
      [requester.id, receiver.id],
    );

    return response.status(201).json({ success: true, connection: result.rows[0] });
  } catch (error) {
    console.error("Could not send connection request", error);
    return response.status(500).json({ error: "Could not send request." });
  }
});

app.post("/api/community/connections/respond", async (request, response) => {
  const parsed = parseConnectionResponse(request.body ?? {});
  if (parsed.error) return response.status(400).json({ error: parsed.error });

  try {
    const user = await findUserByUsername(parsed.value.username);
    if (!user) return response.status(404).json({ error: "User not found." });

    const result = await pool.query(
      `UPDATE community_connections
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND receiver_id = $3 AND status = 'pending'
       RETURNING id, status, updated_at`,
      [parsed.value.status, parsed.value.connectionId, user.id],
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: "Pending request not found." });
    }

    return response.json({ success: true, connection: result.rows[0] });
  } catch (error) {
    console.error("Could not respond to connection request", error);
    return response.status(500).json({ error: "Could not update request." });
  }
});

app.post("/api/community/posts/:postId/like", async (request, response) => {
  const username = parseCommunityUsername(request.body ?? {});
  const postId = Number(request.params.postId);
  if (username.error) return response.status(400).json({ error: username.error });
  if (!Number.isSafeInteger(postId) || postId < 1) {
    return response.status(400).json({ error: "A valid post is required." });
  }

  try {
    const user = await findUserByUsername(username.value);
    if (!user) return response.status(404).json({ error: "User not found." });

    const existing = await pool.query(
      `SELECT 1 FROM community_post_likes WHERE post_id = $1 AND user_id = $2`,
      [postId, user.id],
    );

    if (existing.rowCount > 0) {
      await pool.query(
        `DELETE FROM community_post_likes WHERE post_id = $1 AND user_id = $2`,
        [postId, user.id],
      );
      return response.json({ success: true, liked: false });
    }

    const result = await pool.query(
      `INSERT INTO community_post_likes (post_id, user_id)
       SELECT $1, $2
       WHERE EXISTS (SELECT 1 FROM community_posts WHERE id = $1)
       ON CONFLICT DO NOTHING
       RETURNING post_id`,
      [postId, user.id],
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: "Post not found." });
    }

    return response.json({ success: true, liked: true });
  } catch (error) {
    console.error("Could not toggle post like", error);
    return response.status(500).json({ error: "Could not update like." });
  }
});

app.post("/api/community/posts/:postId/save", async (request, response) => {
  const username = parseCommunityUsername(request.body ?? {});
  const postId = Number(request.params.postId);
  if (username.error) return response.status(400).json({ error: username.error });
  if (!Number.isSafeInteger(postId) || postId < 1) {
    return response.status(400).json({ error: "A valid post is required." });
  }

  try {
    const user = await findUserByUsername(username.value);
    if (!user) return response.status(404).json({ error: "User not found." });

    const existing = await pool.query(
      `SELECT 1 FROM community_post_saves WHERE post_id = $1 AND user_id = $2`,
      [postId, user.id],
    );

    if (existing.rowCount > 0) {
      await pool.query(
        `DELETE FROM community_post_saves WHERE post_id = $1 AND user_id = $2`,
        [postId, user.id],
      );
      return response.json({ success: true, saved: false });
    }

    const result = await pool.query(
      `INSERT INTO community_post_saves (post_id, user_id)
       SELECT $1, $2
       WHERE EXISTS (SELECT 1 FROM community_posts WHERE id = $1)
       ON CONFLICT DO NOTHING
       RETURNING post_id`,
      [postId, user.id],
    );

    if (result.rowCount === 0) {
      return response.status(404).json({ error: "Post not found." });
    }

    return response.json({ success: true, saved: true });
  } catch (error) {
    console.error("Could not toggle post save", error);
    return response.status(500).json({ error: "Could not update saved post." });
  }
});

app.post("/api/community/clubs/:clubId/membership", async (request, response) => {
  const parsed = parseClubMembershipRequest(request.body ?? {}, request.params);
  if (parsed.error) return response.status(400).json({ error: parsed.error });

  try {
    const user = await findUserByUsername(parsed.value.username);
    if (!user) return response.status(404).json({ error: "User not found." });

    const club = await pool.query(
      `SELECT id, privacy FROM community_clubs WHERE id = $1`,
      [parsed.value.clubId],
    );

    if (!club.rows[0]) {
      return response.status(404).json({ error: "Investor club not found." });
    }

    const status = club.rows[0].privacy === "private" ? "pending" : "accepted";
    const result = await pool.query(
      `INSERT INTO community_club_members (club_id, user_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (club_id, user_id)
       DO UPDATE SET status = community_club_members.status
       RETURNING club_id, status`,
      [parsed.value.clubId, user.id, status],
    );

    return response.json({ success: true, membership: result.rows[0] });
  } catch (error) {
    console.error("Could not update club membership", error);
    return response.status(500).json({ error: "Could not update club membership." });
  }
});

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
