package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (s *Store) GetChannelMedia(ctx context.Context, channel, account, hash, representation string) (string, error) {
	var id string
	err := s.Pool.QueryRow(ctx, `SELECT remote_id FROM channel_media_cache WHERE channel_kind=$1 AND account_id=$2 AND hash=$3 AND representation=$4`, channel, account, hash, representation).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func (s *Store) PutChannelMedia(ctx context.Context, channel, account, hash, representation, id string) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO channel_media_cache(channel_kind,account_id,hash,representation,remote_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_kind,account_id,hash,representation) DO UPDATE SET remote_id=excluded.remote_id`, channel, account, hash, representation, id)
	return err
}

func (s *Store) DeleteChannelMedia(ctx context.Context, channel, account, hash, representation, id string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM channel_media_cache WHERE channel_kind=$1 AND account_id=$2 AND hash=$3 AND representation=$4 AND remote_id=$5`, channel, account, hash, representation, id)
	return err
}
