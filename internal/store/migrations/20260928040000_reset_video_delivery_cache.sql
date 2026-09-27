-- Re-upload videos with dimensions extracted from the original file.
DELETE FROM channel_media_cache
WHERE channel_kind = 'telegram'
    AND representation = 'video';
