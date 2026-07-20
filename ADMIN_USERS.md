# Managing `app_users` as an Admin

The `caplore_admin` dashboard manages this table through backend admin API
routes. For production, configure the backend admin password hash and admin
JWT secret instead of putting a plaintext admin password in the admin app.

Set these on the backend host:

```sh
ADMIN_DASHBOARD_PASSWORD_HASH=<bcrypt hash of the admin password>
ADMIN_JWT_SECRET=<long random secret>
ADMIN_JWT_EXPIRES_IN=8h
```

Generate the admin password hash from this directory:

```sh
node scripts/hash-password.mjs "YourAdminPassword"
```

The direct `psql` steps below are still useful for emergency/manual operations.

Table shape (defined in `db/schema.mjs`):

```sql
app_users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(40) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone_number VARCHAR(16) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

Passwords are never stored in plaintext — `password_hash` is a bcrypt hash.
Any insert/update that sets a password must hash it first.

## 1. Connect to the database

From `caplore_backend/` (Railway CLI already linked to the `laudable-education`
project):

```sh
railway connect Postgres
```

This opens an interactive `psql` shell connected directly to the production
database. Requires `psql` installed locally. Everything below is typed at
that `psql` prompt.

## 2. Hash a password before inserting/updating one

Use the helper script (added alongside this doc, uses the same `bcryptjs`
dependency already in `package.json`):

```sh
node scripts/hash-password.mjs "TheirNewPassword123!"
```

This prints a bcrypt hash, e.g. `$2a$10$g5LyD3.RTUah9TYHpXdPw.WX7GoQJmrxhTv5iTbE9PRr1zPc9MlXi`.
Copy it into the SQL below in place of `<hash>`. Run this on your machine —
never type a plaintext password directly into a SQL statement.

## 3. Insert a new user

```sql
INSERT INTO app_users (username, name, email, phone_number, password_hash)
VALUES ('jdoe', 'Jane Doe', 'jane.doe@example.com', '+14155550100', '<hash>');
```

`username` must be unique — the insert fails if it's already taken.

## 4. Update a user

Update profile fields:

```sql
UPDATE app_users
SET name = 'New Name', email = 'new.email@example.com', phone_number = '+14155550199'
WHERE username = 'jdoe';
```

Update just the password (hash a new password first, per step 2):

```sql
UPDATE app_users
SET password_hash = '<hash>'
WHERE username = 'jdoe';
```

## 5. Delete a user

```sql
DELETE FROM app_users WHERE username = 'jdoe';
```

## Notes

- Always scope `UPDATE`/`DELETE` with a `WHERE username = '...'` — there's no
  confirmation prompt in `psql` for a bare `UPDATE`/`DELETE` on the whole table.
- Check what you're about to change first: `SELECT * FROM app_users WHERE username = 'jdoe';`
- The three seeded demo accounts (`alice.chen`, `bob.martins`, `carla.singh`)
  are re-inserted on every backend boot via `ON CONFLICT (username) DO NOTHING`
  in `server.mjs` — deleting them will not stick across a redeploy/restart
  unless you also remove them from the `DUMMY_USERS` array in `server.mjs`.
- Exit `psql` with `\q`.
