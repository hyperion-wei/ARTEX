package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/Autumn-27/artex/db"
)

// 接口鉴权档案的 HTTP 层。三个端点：
//
//	GET    /api/endpoint-auth?asset_id=N     单条（无档案时 auth=null）
//	GET    /api/endpoint-auth?ids=1,2,3      批量，供资产列表一页一次取回
//	GET    /api/endpoint-auth?missing=1      「要鉴权但还没凭据」的待办清单
//	POST   /api/endpoint-auth                新增或覆盖一条
//	DELETE /api/endpoint-auth?asset_id=N     删除一条
//
// 读接口不带凭据也能拿到（掩码在前端做），与流量库、LLM 录制库的可见性一致：
// 能登录就等于能看全部数据，这里不再单独设第二套权限。

// endpointAuthStore 返回资产子系统（鉴权档案挂在它上）；nil 表示数据源不可用。
func (s *Server) endpointAuthStore() *db.AssetStore {
	if s.m == nil || s.m.pg == nil {
		return nil
	}
	return s.m.pg.Assets()
}

func (s *Server) getEndpointAuth(w http.ResponseWriter, r *http.Request) {
	d := s.endpointAuthStore()
	if d == nil {
		writeErr(w, 503, "database unavailable")
		return
	}
	q := r.URL.Query()

	// 待办清单：AI 和页面都用它来挑「下一步该拿哪个接口的凭据」。
	if q.Get("missing") == "1" {
		limit, _ := strconv.Atoi(q.Get("limit"))
		items, err := d.ListMissingEndpointAuth(limit)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		if items == nil {
			items = []*db.EndpointAuth{}
		}
		writeJSON(w, 200, map[string]any{"items": items, "count": len(items)})
		return
	}

	if idsRaw := strings.TrimSpace(q.Get("ids")); idsRaw != "" {
		ids := make([]int64, 0, 8)
		for _, part := range strings.Split(idsRaw, ",") {
			id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
			if err != nil || id <= 0 {
				writeErr(w, 400, "ids 里有一个不是正整数")
				return
			}
			ids = append(ids, id)
		}
		byID, err := d.ListEndpointAuthByAssetIDs(ids)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		items := make([]*db.EndpointAuth, 0, len(byID))
		for _, a := range byID {
			items = append(items, a)
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}

	assetID, err := strconv.ParseInt(q.Get("asset_id"), 10, 64)
	if err != nil || assetID <= 0 {
		writeErr(w, 400, "需要 asset_id、ids 或 missing=1")
		return
	}
	a, err := d.GetEndpointAuth(assetID)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	// 没有档案是正常状态（多数接口还没被登记过），回 null 而不是 404，
	// 前端就不用为「查不到」写一条错误分支。
	writeJSON(w, 200, map[string]any{"auth": a})
}

func (s *Server) saveEndpointAuth(w http.ResponseWriter, r *http.Request) {
	d := s.endpointAuthStore()
	if d == nil {
		writeErr(w, 503, "database unavailable")
		return
	}
	var req db.EndpointAuth
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if req.AssetID <= 0 {
		writeErr(w, 400, "asset_id 必填")
		return
	}
	// 凭据是人在页面上逐字段核对过的，AI 回写时可能只补了 fields；updated_by
	// 留空时按来源给个默认署名，便于事后区分是谁改的。
	if req.UpdatedBy == "" {
		if req.Source == "ai" {
			req.UpdatedBy = "ai"
		} else {
			req.UpdatedBy = "manual"
		}
	}
	if err := d.UpsertEndpointAuth(&req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	// 回读一次：has_credential 这类由服务端推导的位，前端要拿到最终值。
	out, err := d.GetEndpointAuth(req.AssetID)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) deleteEndpointAuth(w http.ResponseWriter, r *http.Request) {
	d := s.endpointAuthStore()
	if d == nil {
		writeErr(w, 503, "database unavailable")
		return
	}
	assetID, err := strconv.ParseInt(r.URL.Query().Get("asset_id"), 10, 64)
	if err != nil || assetID <= 0 {
		writeErr(w, 400, "需要 asset_id")
		return
	}
	if err := d.DeleteEndpointAuth(assetID); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
