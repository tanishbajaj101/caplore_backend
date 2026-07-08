import { Router } from "express";
import { pool } from "../db/pool.mjs";
import { requireAuth } from "../middleware/auth.mjs";
import { createPresignedUpload, publicUrlForObjectKey } from "../lib/s3.mjs";
import {
  parsePostBody,
  parseCommentBody,
  parsePresignRequest,
  parseConnectionRequest,
  parseConnectionResponse,
} from "../lib/validation.mjs";

export const communityRouter = Router();
communityRouter.use(requireAuth);

async function getAcceptedPeerIds(userId) {
  const result = await pool.query(
    `SELECT CASE WHEN user_low_id = $1 THEN user_high_id ELSE user_low_id END AS peer_id
     FROM connections
     WHERE status = 'accepted' AND (user_low_id = $1 OR user_high_id = $1)`,
    [userId],
  );
  return result.rows.map((row) => Number(row.peer_id));
}

async function canViewPost(userId, postId) {
  const result = await pool.query(`SELECT author_id FROM posts WHERE id = $1`, [postId]);
  const post = result.rows[0];
  if (!post) return false;

  const authorId = Number(post.author_id);
  if (authorId === userId) return true;

  const peerIds = await getAcceptedPeerIds(userId);
  return peerIds.includes(authorId);
}

async function attachImages(rows) {
  const postIds = rows.map((row) => row.id);
  const imagesResult = await pool.query(
    `SELECT id, post_id, object_key
     FROM post_images
     WHERE post_id = ANY($1::bigint[])
     ORDER BY post_id, position ASC, id ASC`,
    [postIds],
  );

  const imagesByPost = new Map();
  for (const image of imagesResult.rows) {
    const key = String(image.post_id);
    const list = imagesByPost.get(key) ?? [];
    list.push({ id: Number(image.id), url: publicUrlForObjectKey(image.object_key) });
    imagesByPost.set(key, list);
  }

  return rows.map((row) => ({
    id: Number(row.id),
    authorUsername: row.author_username,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    images: imagesByPost.get(String(row.id)) ?? [],
    likeCount: Number(row.like_count),
    commentCount: Number(row.comment_count),
    likedByMe: row.liked_by_me,
  }));
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

communityRouter.get("/feed", async (request, response) => {
  const limit = Math.min(Math.max(Number.parseInt(request.query.limit, 10) || 20, 1), 50);
  const before = typeof request.query.before === "string" ? request.query.before : null;

  try {
    const peerIds = await getAcceptedPeerIds(request.userId);
    const authorIds = [request.userId, ...peerIds];

    const result = await pool.query(
      `SELECT p.id, p.body, p.created_at, u.username AS author_username, u.name AS author_name,
              COALESCE(l.like_count, 0) AS like_count,
              COALESCE(c.comment_count, 0) AS comment_count,
              EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $2) AS liked_by_me
       FROM posts p
       JOIN app_users u ON u.id = p.author_id
       LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM likes GROUP BY post_id) l ON l.post_id = p.id
       LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM comments GROUP BY post_id) c ON c.post_id = p.id
       WHERE p.author_id = ANY($1::bigint[])
         AND ($3::timestamptz IS NULL OR p.created_at < $3::timestamptz)
       ORDER BY p.created_at DESC
       LIMIT $4`,
      [authorIds, request.userId, before, limit],
    );

    const posts = result.rows.length ? await attachImages(result.rows) : [];
    const nextCursor = posts.length === limit ? posts[posts.length - 1].createdAt : null;

    return response.json({ success: true, posts, nextCursor });
  } catch (error) {
    console.error("Could not load feed", error);
    return response.status(500).json({ error: "Could not load the feed." });
  }
});

communityRouter.post("/posts", async (request, response) => {
  const parsed = parsePostBody(request.body ?? {});
  if (parsed.error) {
    return response.status(400).json({ error: parsed.error });
  }

  const ownedPrefix = `posts/${request.userId}/`;
  if (parsed.value.imageKeys.some((key) => !key.startsWith(ownedPrefix))) {
    return response.status(400).json({ error: "Invalid image selection." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const postResult = await client.query(
      `INSERT INTO posts (author_id, body) VALUES ($1, $2) RETURNING id, created_at`,
      [request.userId, parsed.value.body],
    );
    const postId = postResult.rows[0].id;

    for (const [index, objectKey] of parsed.value.imageKeys.entries()) {
      await client.query(
        `INSERT INTO post_images (post_id, object_key, position) VALUES ($1, $2, $3)`,
        [postId, objectKey, index],
      );
    }

    await client.query("COMMIT");

    const userResult = await pool.query(`SELECT username, name FROM app_users WHERE id = $1`, [request.userId]);
    const images = parsed.value.imageKeys.map((key, index) => ({ id: index, url: publicUrlForObjectKey(key) }));

    return response.status(201).json({
      success: true,
      post: {
        id: Number(postId),
        authorUsername: userResult.rows[0].username,
        authorName: userResult.rows[0].name,
        body: parsed.value.body,
        createdAt: postResult.rows[0].created_at,
        images,
        likeCount: 0,
        commentCount: 0,
        likedByMe: false,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not create post", error);
    return response.status(500).json({ error: "Could not create the post." });
  } finally {
    client.release();
  }
});

communityRouter.post("/uploads/presign", async (request, response) => {
  const parsed = parsePresignRequest(request.body ?? {});
  if (parsed.error) {
    return response.status(400).json({ error: parsed.error });
  }

  try {
    const uploads = await Promise.all(
      parsed.value.files.map((file) =>
        createPresignedUpload({ userId: request.userId, contentType: file.contentType }),
      ),
    );

    return response.json({ success: true, uploads });
  } catch (error) {
    console.error("Could not create presigned upload", error);
    return response
      .status(500)
      .json({ error: "Could not prepare image upload. Please try again." });
  }
});

communityRouter.post("/connections", async (request, response) => {
  const parsed = parseConnectionRequest(request.body ?? {});
  if (parsed.error) {
    return response.status(400).json({ error: parsed.error });
  }

  if (parsed.value.receiverUsername === request.username) {
    return response.status(400).json({ error: "You cannot connect with yourself." });
  }

  try {
    const receiverResult = await pool.query(
      `SELECT id, username, name FROM app_users WHERE username = $1`,
      [parsed.value.receiverUsername],
    );
    const receiver = receiverResult.rows[0];

    if (!receiver) {
      return response.status(404).json({ error: "User not found." });
    }

    const receiverId = Number(receiver.id);
    const lowId = Math.min(request.userId, receiverId);
    const highId = Math.max(request.userId, receiverId);

    const existing = await pool.query(
      `SELECT id, status FROM connections WHERE user_low_id = $1 AND user_high_id = $2`,
      [lowId, highId],
    );

    if (existing.rows[0] && existing.rows[0].status !== "rejected") {
      return response.status(409).json({ error: "A connection already exists with this user." });
    }

    let row;
    if (existing.rows[0]) {
      const updateResult = await pool.query(
        `UPDATE connections SET requester_id = $1, status = 'pending', responded_at = NULL, created_at = NOW()
         WHERE id = $2 RETURNING id, status, created_at`,
        [request.userId, existing.rows[0].id],
      );
      row = updateResult.rows[0];
    } else {
      const insertResult = await pool.query(
        `INSERT INTO connections (user_low_id, user_high_id, requester_id, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id, status, created_at`,
        [lowId, highId, request.userId],
      );
      row = insertResult.rows[0];
    }

    return response.status(201).json({
      success: true,
      connection: {
        id: Number(row.id),
        status: row.status,
        createdAt: row.created_at,
        otherUser: { username: receiver.username, name: receiver.name },
      },
    });
  } catch (error) {
    console.error("Could not create connection request", error);
    return response.status(500).json({ error: "Could not send connection request." });
  }
});

communityRouter.post("/connections/:id/respond", async (request, response) => {
  const parsed = parseConnectionResponse(request.body ?? {});
  if (parsed.error) {
    return response.status(400).json({ error: parsed.error });
  }

  const connectionId = parsePositiveInt(request.params.id);
  if (!connectionId) {
    return response.status(400).json({ error: "Invalid connection id." });
  }

  try {
    const existing = await pool.query(
      `SELECT id, user_low_id, user_high_id, requester_id, status FROM connections WHERE id = $1`,
      [connectionId],
    );
    const connection = existing.rows[0];

    if (
      !connection ||
      (Number(connection.user_low_id) !== request.userId && Number(connection.user_high_id) !== request.userId)
    ) {
      return response.status(404).json({ error: "Connection request not found." });
    }

    if (Number(connection.requester_id) === request.userId) {
      return response.status(403).json({ error: "You cannot respond to your own request." });
    }

    if (connection.status !== "pending") {
      return response.status(409).json({ error: "This request has already been responded to." });
    }

    const updateResult = await pool.query(
      `UPDATE connections SET status = $1, responded_at = NOW() WHERE id = $2 RETURNING id, status`,
      [parsed.value.status, connectionId],
    );

    return response.json({
      success: true,
      connection: { id: Number(updateResult.rows[0].id), status: updateResult.rows[0].status },
    });
  } catch (error) {
    console.error("Could not respond to connection request", error);
    return response.status(500).json({ error: "Could not update the connection request." });
  }
});

communityRouter.get("/connections", async (request, response) => {
  try {
    const result = await pool.query(
      `SELECT u.username, u.name, c.responded_at AS connected_since
       FROM connections c
       JOIN app_users u ON u.id = CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END
       WHERE c.status = 'accepted' AND (c.user_low_id = $1 OR c.user_high_id = $1)
       ORDER BY c.responded_at DESC`,
      [request.userId],
    );

    return response.json({
      success: true,
      connections: result.rows.map((row) => ({
        username: row.username,
        name: row.name,
        connectedSince: row.connected_since,
      })),
    });
  } catch (error) {
    console.error("Could not load connections", error);
    return response.status(500).json({ error: "Could not load connections." });
  }
});

communityRouter.get("/connections/requests", async (request, response) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.created_at, u.username, u.name
       FROM connections c
       JOIN app_users u ON u.id = c.requester_id
       WHERE c.status = 'pending' AND c.requester_id != $1 AND (c.user_low_id = $1 OR c.user_high_id = $1)
       ORDER BY c.created_at DESC`,
      [request.userId],
    );

    return response.json({
      success: true,
      requests: result.rows.map((row) => ({
        id: Number(row.id),
        createdAt: row.created_at,
        fromUser: { username: row.username, name: row.name },
      })),
    });
  } catch (error) {
    console.error("Could not load connection requests", error);
    return response.status(500).json({ error: "Could not load connection requests." });
  }
});

communityRouter.get("/connections/suggestions", async (request, response) => {
  try {
    const result = await pool.query(
      `SELECT username, name FROM app_users
       WHERE id != $1
         AND id NOT IN (
           SELECT CASE WHEN user_low_id = $1 THEN user_high_id ELSE user_low_id END
           FROM connections
           WHERE (user_low_id = $1 OR user_high_id = $1) AND status IN ('pending', 'accepted')
         )
       ORDER BY created_at DESC
       LIMIT 20`,
      [request.userId],
    );

    return response.json({ success: true, suggestions: result.rows });
  } catch (error) {
    console.error("Could not load suggestions", error);
    return response.status(500).json({ error: "Could not load suggestions." });
  }
});

communityRouter.post("/posts/:id/like", async (request, response) => {
  const postId = parsePositiveInt(request.params.id);
  if (!postId) {
    return response.status(400).json({ error: "Invalid post id." });
  }

  try {
    const visible = await canViewPost(request.userId, postId);
    if (!visible) {
      return response.status(404).json({ error: "Post not found." });
    }

    const insertResult = await pool.query(
      `INSERT INTO likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT (post_id, user_id) DO NOTHING RETURNING id`,
      [postId, request.userId],
    );

    let liked;
    if (insertResult.rows.length) {
      liked = true;
    } else {
      await pool.query(`DELETE FROM likes WHERE post_id = $1 AND user_id = $2`, [postId, request.userId]);
      liked = false;
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM likes WHERE post_id = $1`, [postId]);

    return response.json({ success: true, liked, likeCount: countResult.rows[0].count });
  } catch (error) {
    console.error("Could not toggle like", error);
    return response.status(500).json({ error: "Could not update like." });
  }
});

communityRouter.post("/posts/:id/comments", async (request, response) => {
  const postId = parsePositiveInt(request.params.id);
  if (!postId) {
    return response.status(400).json({ error: "Invalid post id." });
  }

  const parsed = parseCommentBody(request.body ?? {});
  if (parsed.error) {
    return response.status(400).json({ error: parsed.error });
  }

  try {
    const visible = await canViewPost(request.userId, postId);
    if (!visible) {
      return response.status(404).json({ error: "Post not found." });
    }

    const insertResult = await pool.query(
      `INSERT INTO comments (post_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [postId, request.userId, parsed.value.body],
    );
    const userResult = await pool.query(`SELECT name FROM app_users WHERE id = $1`, [request.userId]);

    return response.status(201).json({
      success: true,
      comment: {
        id: Number(insertResult.rows[0].id),
        authorUsername: request.username,
        authorName: userResult.rows[0]?.name ?? request.username,
        body: parsed.value.body,
        createdAt: insertResult.rows[0].created_at,
      },
    });
  } catch (error) {
    console.error("Could not create comment", error);
    return response.status(500).json({ error: "Could not add comment." });
  }
});

communityRouter.get("/posts/:id/comments", async (request, response) => {
  const postId = parsePositiveInt(request.params.id);
  if (!postId) {
    return response.status(400).json({ error: "Invalid post id." });
  }

  try {
    const visible = await canViewPost(request.userId, postId);
    if (!visible) {
      return response.status(404).json({ error: "Post not found." });
    }

    const result = await pool.query(
      `SELECT c.id, c.body, c.created_at, u.username, u.name
       FROM comments c
       JOIN app_users u ON u.id = c.author_id
       WHERE c.post_id = $1
       ORDER BY c.created_at ASC`,
      [postId],
    );

    return response.json({
      success: true,
      comments: result.rows.map((row) => ({
        id: Number(row.id),
        authorUsername: row.username,
        authorName: row.name,
        body: row.body,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("Could not load comments", error);
    return response.status(500).json({ error: "Could not load comments." });
  }
});
