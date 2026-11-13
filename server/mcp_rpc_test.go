package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Autumn-27/artex/mcphttp"
)

func TestMCPAccessTokenLifecycle(t *testing.T) {
	m, err := NewManager(t.TempDir(), "")
	if err != nil {
		t.Skipf("postgres unavailable (%v)", err)
	}
	defer m.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	td := t.TempDir()
	s := New(ctx, m, td, td, td)
	h := s.Handler()
	jwt, err := signJWT(s.jwtKey)
	if err != nil {
		t.Fatal(err)
	}

	request := func(method, path string, body any, bearer string) (int, map[string]any, string) {
		var raw []byte
		if body != nil {
			raw, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		var decoded map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &decoded)
		return rec.Code, decoded, rec.Body.String()
	}

	code, created, _ := request("POST", "/api/mcp-access/tokens", map[string]any{
		"name": "integration-test", "tools": []string{"list_tasks"},
	}, jwt)
	if code != http.StatusCreated {
		t.Fatalf("create token: %d %v", code, created)
	}
	secret, _ := created["token"].(string)
	access, _ := created["access_token"].(map[string]any)
	id := int64(access["id"].(float64))
	if secret == "" || !strings.HasPrefix(secret, mcpTokenPrefix) {
		t.Fatalf("unexpected secret response: %v", created)
	}
	defer m.pg.DeleteMCPAccessToken(id)

	code, _, body := request("GET", "/api/mcp-access/tokens", nil, jwt)
	if code != http.StatusOK || strings.Contains(body, secret) {
		t.Fatalf("token list leaked secret or failed: %d %s", code, body)
	}

	code, _, _ = request("POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": "unauthorized", "method": "initialize", "params": map[string]any{},
	}, "")
	if code != http.StatusUnauthorized {
		t.Fatalf("missing bearer should be unauthorized: %d", code)
	}

	code, initialized, _ := request("POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": "init-1", "method": "initialize", "params": map[string]any{},
	}, secret)
	if code != http.StatusOK {
		t.Fatalf("initialize: %d %v", code, initialized)
	}
	result := initialized["result"].(map[string]any)
	if result["protocolVersion"] != mcpStreamableProtocolVersion {
		t.Fatalf("unexpected protocol response: %v", initialized)
	}

	code, listed, _ := request("POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{},
	}, secret)
	if code != http.StatusOK {
		t.Fatalf("tools/list: %d %v", code, listed)
	}
	tools := listed["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "list_tasks" {
		t.Fatalf("token tool whitelist was not enforced: %v", listed)
	}

	code, called, _ := request("POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 3, "method": "tools/call",
		"params": map[string]any{"name": "list_tasks", "arguments": map[string]any{}},
	}, secret)
	if code != http.StatusOK {
		t.Fatalf("tools/call: %d %v", code, called)
	}
	callResult := called["result"].(map[string]any)
	content := callResult["content"].([]any)
	text := content[0].(map[string]any)["text"].(string)
	var tasks []any
	if err := json.Unmarshal([]byte(text), &tasks); err != nil {
		t.Fatalf("list_tasks returned non-JSON text: %q", text)
	}

	live := httptest.NewServer(h)
	defer live.Close()
	client, err := mcphttp.New(context.Background(), "artex", live.URL+"/mcp", map[string]string{"Authorization": "Bearer " + secret}, false)
	if err != nil {
		t.Fatalf("external MCP initialize: %v", err)
	}
	defer client.Close()
	remoteTools, err := client.Tools(context.Background())
	if err != nil || len(remoteTools) != 1 || remoteTools[0].Name() != "mcp__artex__list_tasks" {
		t.Fatalf("external tools/list = %#v, %v", remoteTools, err)
	}
	if _, err := client.Call(context.Background(), "list_tasks", map[string]any{}); err != nil {
		t.Fatalf("external list_tasks call: %v", err)
	}

	code, denied, _ := request("POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 4, "method": "tools/call",
		"params": map[string]any{"name": "create_skill", "arguments": map[string]any{}},
	}, secret)
	if code != http.StatusOK || denied["error"] == nil {
		t.Fatalf("unauthorized tool should return JSON-RPC error: %d %v", code, denied)
	}

	code, _, _ = request("POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "method": "notifications/initialized", "params": map[string]any{},
	}, secret)
	if code != http.StatusAccepted {
		t.Fatalf("notification should be accepted: %d", code)
	}

	code, _, _ = request("PATCH", "/api/mcp-access/tokens/"+itoaTest(id), map[string]any{"enabled": false}, jwt)
	if code != http.StatusOK {
		t.Fatalf("disable token: %d", code)
	}
	code, _, _ = request("POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 5, "method": "ping", "params": map[string]any{},
	}, secret)
	if code != http.StatusUnauthorized {
		t.Fatalf("disabled token should be rejected: %d", code)
	}
}
