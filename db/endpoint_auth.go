package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// 接口鉴权档案（表 endpoint_auth）。一条接口/服务资产一行，回答「要不要鉴权」
// 和「手上有没有凭据」。字段设计见 schema.sql 里的注释块。

// EndpointAuthField 一个被识别出来的鉴权字段：名字 + 出现位置。
type EndpointAuthField struct {
	Name  string `json:"name"`
	Where string `json:"where"` // header | query | body | cookie
	Kind  string `json:"kind,omitempty"`
}

// EndpointAuthAccount 账号口令型凭据（basic / 表单登录）。
type EndpointAuthAccount struct {
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// EndpointAuthCredential 可直接用于复放请求的凭据集合。明文存放，前端默认掩码。
type EndpointAuthCredential struct {
	Headers map[string]string    `json:"headers,omitempty"`
	Cookies map[string]string    `json:"cookies,omitempty"`
	Params  map[string]string    `json:"params,omitempty"`
	Account *EndpointAuthAccount `json:"account,omitempty"`
	Raw     string               `json:"raw,omitempty"` // 整段 Authorization/Cookie 原文
}

// empty 报告凭据集合是否一个值都没有——has_credential 由它推导，
// 免得调用方填了 credential 却忘了置位，档案自相矛盾。
func (c EndpointAuthCredential) empty() bool {
	return len(c.Headers) == 0 && len(c.Cookies) == 0 && len(c.Params) == 0 && c.Account == nil && c.Raw == ""
}

// EndpointAuth 一行鉴权档案。
type EndpointAuth struct {
	AssetID       int64                  `json:"asset_id"`
	NeedsAuth     bool                   `json:"needs_auth"`
	AuthKind      string                 `json:"auth_kind"`
	HasCredential bool                   `json:"has_credential"`
	Verified      bool                   `json:"verified"`
	Fields        []EndpointAuthField    `json:"fields"`
	Credential    EndpointAuthCredential `json:"credential"`
	Source        string                 `json:"source"`
	Confidence    float64                `json:"confidence"`
	Note          string                 `json:"note,omitempty"`
	UpdatedBy     string                 `json:"updated_by,omitempty"`
	CreatedAt     time.Time              `json:"created_at"`
	UpdatedAt     time.Time              `json:"updated_at"`
	// 以下两列只读：查询时 LEFT JOIN assets 带出来，让 AI 和页面不必再拿
	// asset_id 回查一次是哪个接口。写入路径不看它们。
	URL    string `json:"url,omitempty"`
	Method string `json:"method,omitempty"`
}

var endpointAuthKinds = map[string]bool{
	"none": true, "basic": true, "bearer": true, "jwt": true, "api_key": true,
	"cookie": true, "session": true, "signature": true, "oauth": true, "unknown": true,
}

var endpointAuthSources = map[string]bool{"manual": true, "ai": true, "traffic": true}

// ErrEndpointAuthNotFound 该资产还没有鉴权档案。
var ErrEndpointAuthNotFound = errors.New("endpoint auth record not found")

const endpointAuthCols = `a.asset_id,a.needs_auth,a.auth_kind,a.has_credential,a.verified,a.fields,a.credential,a.source,a.confidence,COALESCE(a.note,''),COALESCE(a.updated_by,''),a.created_at,a.updated_at,COALESCE(s.url,''),COALESCE(s.method,'')`

// endpointAuthFrom 把档案表与资产表连起来取：一个鉴权记录总得说清它属于哪个接口。
const endpointAuthFrom = ` FROM endpoint_auth a LEFT JOIN assets s ON s.id = a.asset_id`

func scanEndpointAuth(sc interface{ Scan(...any) error }) (*EndpointAuth, error) {
	var a EndpointAuth
	var fields, cred []byte
	if err := sc.Scan(&a.AssetID, &a.NeedsAuth, &a.AuthKind, &a.HasCredential, &a.Verified,
		&fields, &cred, &a.Source, &a.Confidence, &a.Note, &a.UpdatedBy, &a.CreatedAt, &a.UpdatedAt,
		&a.URL, &a.Method); err != nil {
		return nil, err
	}
	// 库里存的是 '[]' / '{}'，解不出来只说明数据被外部改坏了；让空值继续往下走
	// 比在这里抛错更有用，页面顶多显示成「未识别到字段」。
	if len(fields) > 0 {
		_ = json.Unmarshal(fields, &a.Fields)
	}
	if len(cred) > 0 {
		_ = json.Unmarshal(cred, &a.Credential)
	}
	return &a, nil
}

// epAuthRunner 让鉴权档案的读写在事务内外走同一条路：资产子系统（AssetStore）
// 有时持有事务（企业归属重算等），有时直接打在连接池上，两边的方法集差异在此吸收。
type epAuthRunner interface {
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
	Exec(string, ...any) (sql.Result, error)
}

func (s *AssetStore) run() epAuthRunner {
	if s.tx != nil {
		return s.tx
	}
	return s.db
}

// GetEndpointAuth 取一条资产的鉴权档案；没有则返回 nil（不报错），调用方按
// 「未登记」处理。
func (s *AssetStore) GetEndpointAuth(assetID int64) (*EndpointAuth, error) {
	a, err := scanEndpointAuth(s.run().QueryRow(`SELECT `+endpointAuthCols+endpointAuthFrom+` WHERE a.asset_id=$1`, assetID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return a, nil
}

// UpsertEndpointAuth 写入或覆盖一条档案。has_credential 由凭据内容推导（给了凭据
// 就算有），auth_kind / source 做白名单校验，避免撞 CHECK 约束变成一句看不出所以然的
// 500。asset_id 必须已存在于 assets：外键会拒掉孤儿档案，这里换成明确错误更好读。
func (s *AssetStore) UpsertEndpointAuth(a *EndpointAuth) error {
	if a.AuthKind == "" {
		a.AuthKind = "unknown"
	}
	if !endpointAuthKinds[a.AuthKind] {
		return fmt.Errorf("auth_kind 非法：%q（可用：none/basic/bearer/jwt/api_key/cookie/session/signature/oauth/unknown）", a.AuthKind)
	}
	if a.Source == "" {
		a.Source = "manual"
	}
	if !endpointAuthSources[a.Source] {
		return fmt.Errorf("source 非法：%q（可用：manual/ai/traffic）", a.Source)
	}
	a.HasCredential = a.HasCredential || !a.Credential.empty()
	// 不需要鉴权的接口谈不上「已验证凭据」，把两个位收敛掉，防止档案里出现
	// needs_auth=false + verified=true 这种自相矛盾的组合。
	if !a.NeedsAuth {
		a.Verified = false
	}
	if a.Fields == nil {
		a.Fields = []EndpointAuthField{}
	}
	for i := range a.Fields {
		a.Fields[i].Where = strings.ToLower(strings.TrimSpace(a.Fields[i].Where))
	}
	fieldsJSON, err := json.Marshal(a.Fields)
	if err != nil {
		return err
	}
	credJSON, err := json.Marshal(a.Credential)
	if err != nil {
		return err
	}
	_, err = s.run().Exec(`
INSERT INTO endpoint_auth(asset_id,needs_auth,auth_kind,has_credential,verified,fields,credential,source,confidence,note,updated_by)
VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NULLIF($10,''),NULLIF($11,''))
ON CONFLICT (asset_id) DO UPDATE SET
  needs_auth=EXCLUDED.needs_auth, auth_kind=EXCLUDED.auth_kind,
  has_credential=EXCLUDED.has_credential, verified=EXCLUDED.verified,
  fields=EXCLUDED.fields, credential=EXCLUDED.credential,
  source=EXCLUDED.source, confidence=EXCLUDED.confidence,
  note=EXCLUDED.note, updated_by=EXCLUDED.updated_by`,
		a.AssetID, a.NeedsAuth, a.AuthKind, a.HasCredential, a.Verified,
		string(fieldsJSON), string(credJSON), a.Source, a.Confidence, a.Note, a.UpdatedBy)
	if err != nil {
		if strings.Contains(err.Error(), "endpoint_asset_id_fkey") || strings.Contains(err.Error(), "foreign key") {
			return fmt.Errorf("资产 %d 不存在，无法登记鉴权信息", a.AssetID)
		}
		return err
	}
	return nil
}

// DeleteEndpointAuth 删除一条档案。资产本身被删时级联会先带走它，这里给人工「清空重填」用。
func (s *AssetStore) DeleteEndpointAuth(assetID int64) error {
	_, err := s.run().Exec(`DELETE FROM endpoint_auth WHERE asset_id=$1`, assetID)
	return err
}

// ListEndpointAuthByAssetIDs 批量取档案，供资产列表一次带出一页的鉴权状态。
// 缺档案的 id 不会出现在返回 map 里（不是错误）。
func (s *AssetStore) ListEndpointAuthByAssetIDs(ids []int64) (map[int64]*EndpointAuth, error) {
	out := make(map[int64]*EndpointAuth, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		// 占位符里的数字来自循环下标，不是用户输入；id 本身走参数绑定。
		ph[i] = "$" + strconv.Itoa(i+1)
		args[i] = id
	}
	rows, err := s.run().Query(`SELECT `+endpointAuthCols+endpointAuthFrom+` WHERE a.asset_id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanEndpointAuth(rows)
		if err != nil {
			return nil, err
		}
		out[a.AssetID] = a
	}
	return out, rows.Err()
}

// ListMissingEndpointAuth 列出「需要鉴权但还没拿到凭据」的接口，按更新时间倒序。
// 既是页面上的待办清单，也是喂给 AI 的下一步目标。
func (s *AssetStore) ListMissingEndpointAuth(limit int) ([]*EndpointAuth, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.run().Query(`SELECT `+endpointAuthCols+endpointAuthFrom+`
WHERE a.needs_auth AND NOT a.has_credential ORDER BY a.updated_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*EndpointAuth
	for rows.Next() {
		a, err := scanEndpointAuth(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
