-- Refresh batches no longer report to Telegram; drop the messages still owed.
DELETE FROM `telegram_deliveries` WHERE `kind` = 'batch';
