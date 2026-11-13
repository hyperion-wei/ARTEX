package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"

	"github.com/Autumn-27/artex/db"
)

const mcpTokenPrefix = "artex_mcp_"

var mcpExportDomainToolKeys = []string{
	"insert_assets", "add_company_scope",
	"list_assets", "list_companies", "list_endpoint_auth",
}

var mcpDangerousExportTools = map[string]bool{
	"create_skill": true, "update_skill_file": true,
	"create_custom_tool": true, "update_custom_tool": true,
	"create_mcp": true, "update_mcp": true,
	"delete_assets_by_host": true,
}

type mcpExportToolInfo struct {
	Name            string `json:"name"`
	Description     string `json:"description"`
	ReadOnly        bool   `json:"read_only"`
	DefaultSelected bool   `json:"default_selected"`
	Dangerous       bool   `json:"dangerous"`
}

func (s *Server) pgMCPAccessTools(w http.ResponseWriter, r *http.Request) {
	_, infos, err := s.mcpExportRegistry(nil)
	if err != nil {
		writeErr(w, 503, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"tools": infos, "default_tools": mcpDefaultToolSelection(infos)})
}

func (s *Server) pgListMCPAccessTokens(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	tokens, err := pg.ListMCPAccessTokens()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"tokens": tokens})
}

func (s *Server) pgCreateMCPAccessToken(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	var req struct {
		Name  string    `json:"name"`
		Tools *[]string `json:"tools"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Agent Token"
	}
	if len([]rune(name)) > 64 {
		writeErr(w, 400, "名称不能超过 64 个字符")
		return
	}
	_, infos, err := s.mcpExportRegistry(nil)
	if err != nil {
		writeErr(w, 503, err.Error())
		return
	}
	var tools []string
	if req.Tools == nil {
		tools = mcpDefaultToolSelection(infos)
	} else {
		tools, err = mcpValidateToolSelection(*req.Tools, infos)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
	}
	secret, err := newMCPAccessToken()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	hash := sha256.Sum256([]byte(secret))
	token := &db.MCPAccessToken{
		Name: name, Prefix: mcpTokenDisplayPrefix(secret), Tools: tools, Enabled: true,
	}
	if err := pg.CreateMCPAccessToken(token, hex.EncodeToString(hash[:])); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"token": secret, "access_token": token})
}

func (s *Server) pgUpdateMCPAccessToken(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	id, ok := pathInt(r, "id")
	if !ok || id <= 0 {
		writeErr(w, 400, "无效 Token ID")
		return
	}
	token, err := pg.GetMCPAccessToken(id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if token == nil {
		writeErr(w, 404, "Token 不存在")
		return
	}
	var req struct {
		Name    *string   `json:"name"`
		Tools   *[]string `json:"tools"`
		Enabled *bool     `json:"enabled"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len([]rune(name)) > 64 {
			writeErr(w, 400, "名称必填且不能超过 64 个字符")
			return
		}
		token.Name = name
	}
	if req.Tools != nil {
		_, infos, err := s.mcpExportRegistry(nil)
		if err != nil {
			writeErr(w, 503, err.Error())
			return
		}
		tools, err := mcpValidateToolSelection(*req.Tools, infos)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		token.Tools = tools
	}
	if req.Enabled != nil {
		token.Enabled = *req.Enabled
	}
	updated, err := pg.UpdateMCPAccessToken(token)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if !updated {
		writeErr(w, 404, "Token 不存在")
		return
	}
	writeJSON(w, 200, map[string]any{"access_token": token})
}

func (s *Server) pgDeleteMCPAccessToken(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	id, ok := pathInt(r, "id")
	if !ok || id <= 0 {
		writeErr(w, 400, "无效 Token ID")
		return
	}
	deleted, err := pg.DeleteMCPAccessToken(id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if !deleted {
		writeErr(w, 404, "Token 不存在")
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": id})
}

func newMCPAccessToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成 Token 失败：%w", err)
	}
	return mcpTokenPrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

func mcpTokenDisplayPrefix(secret string) string {
	const prefixLen = len(mcpTokenPrefix) + 8
	if len(secret) <= prefixLen {
		return secret
	}
	return secret[:prefixLen]
}
