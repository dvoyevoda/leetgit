CREATE TABLE auth_flows (
  state_hash TEXT PRIMARY KEY NOT NULL,
  browser_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_state TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('oauth', 'install')),
  verifier TEXT,
  installation_id INTEGER,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX auth_flows_expiration ON auth_flows (expires_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  installation_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  repository_private INTEGER NOT NULL CHECK (repository_private IN (0, 1)),
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_expiration ON sessions (expires_at);
