-- Required for broker upsert: ON CONFLICT (token_symbol) DO UPDATE
ALTER TABLE unlock_analysis
  ADD CONSTRAINT unlock_analysis_token_symbol_key UNIQUE (token_symbol);
