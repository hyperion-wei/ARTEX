package db

import (
	"database/sql"
	"encoding/json"
	"time"
)

type MCPAccessToken struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Tools      []string   `json:"tools"`
	Enabled    bool       `json:"enabled"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
}

const mcpAccessTokenCols = `id,name,token_prefix,tools,enabled,created_at,last_used_at`

func scanMCPAccessToken(row interface{ Scan(...any) error }) (*MCPAccessToken, error) {
	var t MCPAccessToken
	var tools []byte
	var lastUsed sql.NullTime
	if err := row.Scan(&t.ID, &t.Name, &t.Prefix, &tools, &t.Enabled, &t.CreatedAt, &lastUsed); err != nil {
		return nil, err
	}
	if len(tools) > 0 {
		if err := json.Unmarshal(tools, &t.Tools); err != nil {
			return nil, err
		}
	}
	if t.Tools == nil {
		t.Tools = []string{}
	}
	if lastUsed.Valid {
		v := lastUsed.Time
		t.LastUsedAt = &v
	}
	return &t, nil
}

func (d *DB) CreateMCPAccessToken(t *MCPAccessToken, tokenHash string) error {
	tools, _ := json.Marshal(t.Tools)
	return d.QueryRow(`INSERT INTO mcp_access_tokens(name,token_hash,token_prefix,tools,enabled)
VALUES ($1,$2,$3,$4,$5) RETURNING id,created_at`, t.Name, tokenHash, t.Prefix, tools, t.Enabled).Scan(&t.ID, &t.CreatedAt)
}

func (d *DB) ListMCPAccessTokens() ([]*MCPAccessToken, error) {
	rows, err := d.Query(`SELECT ` + mcpAccessTokenCols + ` FROM mcp_access_tokens ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*MCPAccessToken{}
	for rows.Next() {
		t, err := scanMCPAccessToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (d *DB) GetMCPAccessToken(id int64) (*MCPAccessToken, error) {
	t, err := scanMCPAccessToken(d.QueryRow(`SELECT `+mcpAccessTokenCols+` FROM mcp_access_tokens WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return t, err
}

func (d *DB) MCPAccessTokenByHash(tokenHash string) (*MCPAccessToken, error) {
	t, err := scanMCPAccessToken(d.QueryRow(`SELECT `+mcpAccessTokenCols+` FROM mcp_access_tokens WHERE token_hash=$1`, tokenHash))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return t, err
}

func (d *DB) TouchMCPAccessToken(id int64) error {
	_, err := d.Exec(`UPDATE mcp_access_tokens SET last_used_at=now() WHERE id=$1`, id)
	return err
}

func (d *DB) UpdateMCPAccessToken(t *MCPAccessToken) (bool, error) {
	tools, _ := json.Marshal(t.Tools)
	res, err := d.Exec(`UPDATE mcp_access_tokens SET name=$2,tools=$3,enabled=$4,updated_at=now() WHERE id=$1`, t.ID, t.Name, tools, t.Enabled)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (d *DB) DeleteMCPAccessToken(id int64) (bool, error) {
	res, err := d.Exec(`DELETE FROM mcp_access_tokens WHERE id=$1`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
