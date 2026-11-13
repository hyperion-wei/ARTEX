package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"sort"
	"strings"
	"time"

	"github.com/Autumn-27/artex/agent"
	"github.com/Autumn-27/artex/db"
	actool "github.com/Autumn-27/norma/tool"
)

const mcpStreamableProtocolVersion = "2025-06-18"

type mcpRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *mcpRPCError    `json:"error,omitempty"`
}

type mcpRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if s.m.pg == nil {
		writeErr(w, http.StatusServiceUnavailable, "管理后台数据源(PostgreSQL)未连接")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeErr(w, http.StatusMethodNotAllowed, "MCP 仅支持 POST")
		return
	}
	token, ok := s.mcpAccessTokenFromRequest(w, r)
	if !ok {
		return
	}
	if err := s.m.pg.TouchMCPAccessToken(token.ID); err != nil {
		log.Printf("[mcp-server] 更新 Token 最后使用时间失败: %v", err)
	}
	registry, _, err := s.mcpExportRegistry(token)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	var req mcpRPCRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeMCPRPC(w, mcpRPCResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &mcpRPCError{Code: -32700, Message: "解析 JSON 请求失败"}})
		return
	}
	if len(req.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if req.JSONRPC != "2.0" || strings.TrimSpace(req.Method) == "" {
		writeMCPRPCError(w, req.ID, -32600, "无效 JSON-RPC 请求")
		return
	}

	switch req.Method {
	case "initialize":
		writeMCPRPC(w, mcpRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{
			"protocolVersion": mcpStreamableProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "artex", "version": BuildVersion},
			"instructions":    "ARTEX 工具服务。只能调用当前 Token 白名单内、且已绑定 Auto 并启用的工具。",
		}})
	case "ping":
		writeMCPRPC(w, mcpRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: json.RawMessage(`{}`)})
	case "tools/list":
		s.mcpListTools(w, req.ID, registry)
	case "tools/call":
		s.mcpCallTool(w, r, req, registry)
	default:
		writeMCPRPCError(w, req.ID, -32601, "方法不存在："+req.Method)
	}
}

func (s *Server) mcpAccessTokenFromRequest(w http.ResponseWriter, r *http.Request) (*db.MCPAccessToken, bool) {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || strings.TrimSpace(parts[1]) == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="artex-mcp"`)
		writeErr(w, http.StatusUnauthorized, "需要 Bearer MCP Token")
		return nil, false
	}
	secret := strings.TrimSpace(parts[1])
	hash := sha256.Sum256([]byte(secret))
	token, err := s.m.pg.MCPAccessTokenByHash(hex.EncodeToString(hash[:]))
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return nil, false
	}
	if token == nil || !token.Enabled {
		w.Header().Set("WWW-Authenticate", `Bearer realm="artex-mcp", error="invalid_token"`)
		writeErr(w, http.StatusUnauthorized, "MCP Token 无效或已停用")
		return nil, false
	}
	return token, true
}

func (s *Server) mcpListTools(w http.ResponseWriter, id json.RawMessage, registry map[string]actool.CoreTool) {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	tools := make([]map[string]any, 0, len(names))
	for _, name := range names {
		tool := registry[name]
		schema := tool.InputSchema()
		if schema == nil {
			schema = map[string]any{"type": "object"}
		}
		tools = append(tools, map[string]any{
			"name": name, "description": tool.Description(), "inputSchema": schema,
		})
	}
	writeMCPRPC(w, mcpRPCResponse{JSONRPC: "2.0", ID: id, Result: map[string]any{"tools": tools}})
}

func (s *Server) mcpCallTool(w http.ResponseWriter, r *http.Request, req mcpRPCRequest, registry map[string]actool.CoreTool) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || strings.TrimSpace(params.Name) == "" {
		writeMCPRPCError(w, req.ID, -32602, "tools/call 需要有效的 name 和 arguments")
		return
	}
	tool := registry[params.Name]
	if tool == nil {
		writeMCPRPCError(w, req.ID, -32602, "工具不存在或未授权："+params.Name)
		return
	}
	args := params.Arguments
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}
	if err := actool.ValidateInput(tool.InputSchema(), args); err != nil {
		writeMCPRPCError(w, req.ID, -32602, "工具参数无效："+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(agent.WithRunInfo(r.Context(), agent.RunInfo{SessionID: fmt.Sprintf("mcp-request-%s", string(req.ID))}), 10*time.Minute)
	defer cancel()
	result, err := callMCPTool(ctx, tool, args, &actool.ToolContext{
		WorkingDir: s.m.dir, AgentID: "external_mcp", ToolUseID: string(req.ID), MaxOutputChars: 30000,
	})
	if err != nil {
		result = actool.Errorf(err.Error())
	}
	writeMCPRPC(w, mcpRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{
		"content": []map[string]any{{"type": "text", "text": result.Flatten()}},
		"isError": result.IsError,
	}})
}

func callMCPTool(ctx context.Context, tool actool.CoreTool, args json.RawMessage, tc *actool.ToolContext) (result actool.Result, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("[mcp-server] 工具 %s panic: %v\n%s", tool.Name(), recovered, debug.Stack())
			result = actool.Errorf("工具执行内部错误")
			err = nil
		}
	}()
	return tool.Call(ctx, args, tc)
}

func writeMCPRPCError(w http.ResponseWriter, id json.RawMessage, code int, message string) {
	writeMCPRPC(w, mcpRPCResponse{JSONRPC: "2.0", ID: id, Error: &mcpRPCError{Code: code, Message: message}})
}

func writeMCPRPC(w http.ResponseWriter, response mcpRPCResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(response)
}
