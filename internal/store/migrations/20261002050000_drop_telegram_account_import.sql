-- Accounts are added on the web in one request. The Telegram credential
-- dialog and its queue replay receipts are gone.
DROP TABLE account_dialogs;

DROP TABLE connection_imports;
