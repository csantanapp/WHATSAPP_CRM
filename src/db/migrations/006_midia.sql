-- Fase 2 retomada: mídia (receber/enviar imagem, áudio, documento, vídeo) +
-- transcrição de áudio.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_filename TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_size_bytes INT;
