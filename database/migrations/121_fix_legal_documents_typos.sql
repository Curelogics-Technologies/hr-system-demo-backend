-- Migration 121: Fix typos in legal documents table
-- 1. Privacy Policy (IT) - section 4 typo cleanup
UPDATE legal_documents
SET content = REPLACE(content, 'opportunità di sto di sto per il futuro', 'opportunità lavorative presenti o future'),
    updated_at = CURRENT_TIMESTAMP
WHERE document_key = 'privacy' AND language = 'it';

-- 2. Terms of Service (IT) - section 5 missing word "uso"
UPDATE legal_documents
SET content = REPLACE(REPLACE(content, 'l''improprio della piattaforma', 'l''uso improprio della piattaforma'), 'utilizzi impropri della piattaforma', 'l''uso improprio della piattaforma'),
    updated_at = CURRENT_TIMESTAMP
WHERE document_key = 'terms' AND language = 'it';

-- 3. Terms of Service (IT) - section 7 typo "I present Termini"
UPDATE legal_documents
SET content = REPLACE(content, 'I present Termini', 'I presenti Termini'),
    updated_at = CURRENT_TIMESTAMP
WHERE document_key = 'terms' AND language = 'it';
