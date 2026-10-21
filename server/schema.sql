CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, display_name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','uploader')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invitations (
 id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, role text NOT NULL CHECK(role IN ('admin','uploader')),
 display_name text NOT NULL, recovery_user_id uuid REFERENCES users(id), expires_at timestamptz NOT NULL,
 used_at timestamptz, revoked_at timestamptz, attempts integer NOT NULL DEFAULT 0, created_by uuid REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
 id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), public_key bytea NOT NULL, counter bigint NOT NULL,
 transports jsonb NOT NULL DEFAULT '[]', backup_state boolean NOT NULL DEFAULT false, device_type text,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS challenges (
 id text PRIMARY KEY, challenge text NOT NULL, purpose text NOT NULL, invitation_id uuid REFERENCES invitations(id),
 user_id uuid, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf_hash text NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS albums (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), title text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','uploading','processing','published','expired','revoked','deleted')),
 total_bytes bigint NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS files (
 id uuid PRIMARY KEY, album_id uuid NOT NULL REFERENCES albums(id), original_name text NOT NULL, stored_name text NOT NULL,
 size_bytes bigint NOT NULL CHECK(size_bytes > 0), sha256 text, expected_sha256 text NOT NULL, mime_type text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','complete','failed')), preview boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS upload_jobs (
 id uuid PRIMARY KEY, album_id uuid NOT NULL REFERENCES albums(id), file_id uuid NOT NULL UNIQUE REFERENCES files(id),
 token_hash text NOT NULL, tus_upload_id text UNIQUE, expected_bytes bigint NOT NULL, received_bytes bigint NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'authorized' CHECK(state IN ('authorized','uploading','processing','complete','failed')),
 expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), error text
);
CREATE TABLE IF NOT EXISTS share_links (
 id uuid PRIMARY KEY, album_id uuid NOT NULL REFERENCES albums(id), token_hash text UNIQUE NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS torrent_swarms (
 id uuid PRIMARY KEY, album_id uuid NOT NULL UNIQUE REFERENCES albums(id), info_hash text UNIQUE,
 torrent_manifest_path text, seed_status text NOT NULL DEFAULT 'pending', last_announced_at timestamptz
);
CREATE TABLE IF NOT EXISTS peer_sessions (
 id text PRIMARY KEY, album_id uuid NOT NULL REFERENCES albums(id), expires_at timestamptz NOT NULL, peer_id text
);
CREATE TABLE IF NOT EXISTS download_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, album_id uuid NOT NULL REFERENCES albums(id),
 pathway text NOT NULL, bytes_sent bigint NOT NULL, client_fingerprint_hash text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL,
 target_type text NOT NULL, target_id text, timestamp timestamptz NOT NULL DEFAULT now(), result text NOT NULL
);
CREATE INDEX IF NOT EXISTS albums_owner ON albums(owner_id);
CREATE INDEX IF NOT EXISTS albums_expiry ON albums(status,expires_at);
CREATE INDEX IF NOT EXISTS upload_expiry ON upload_jobs(state,expires_at);
CREATE TABLE IF NOT EXISTS system_settings (
 id integer PRIMARY KEY CHECK(id=1), configuration jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
