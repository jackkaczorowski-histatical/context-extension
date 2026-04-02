-- Session transcripts
CREATE TABLE session_transcripts (
  id BIGSERIAL PRIMARY KEY,
  install_id TEXT,
  user_id TEXT,
  video_title TEXT,
  video_url TEXT,
  transcript TEXT,
  duration_seconds INTEGER,
  entity_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Session entities (every entity extracted, globally)
CREATE TABLE session_entities (
  id BIGSERIAL PRIMARY KEY,
  install_id TEXT,
  user_id TEXT,
  term TEXT NOT NULL,
  type TEXT,
  description TEXT,
  video_title TEXT,
  video_url TEXT,
  reaction TEXT, -- 'new_to_me', 'knew_this', or null
  starred BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tell me more queries
CREATE TABLE ask_queries (
  id BIGSERIAL PRIMARY KEY,
  install_id TEXT,
  user_id TEXT,
  question TEXT,
  term TEXT,
  video_title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transcripts_user ON session_transcripts(user_id);
CREATE INDEX idx_entities_term ON session_entities(term);
CREATE INDEX idx_entities_type ON session_entities(type);
CREATE INDEX idx_entities_reaction ON session_entities(reaction);
CREATE INDEX idx_ask_user ON ask_queries(user_id);
